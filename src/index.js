import { createClient } from "@supabase/supabase-js";

const env = process.env;
const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "AI_API_KEY"];
for (const key of required) {
  if (!env[key]) throw new Error(`Missing environment variable: ${key}`);
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const intervalMinutes = Number(env.POST_INTERVAL_MINUTES || 60);
const dryRun = String(env.DRY_RUN || "true").toLowerCase() === "true";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data
  }));
}

async function aiGenerate(prompt) {
  const base = (env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.AI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.AI_MODEL || "gpt-5.6-mini",
      temperature: 0.85,
      messages: [
        {
          role: "system",
          content:
            "Kamu adalah editor novel serial. Jaga kontinuitas karakter, waktu, lokasi, konflik, dan gaya. Jangan mengarang ulang fakta yang sudah dikunci dalam story bible."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`AI API ${response.status}: ${await response.text()}`);
  }

  const json = await response.json();
  return json.choices?.[0]?.message?.content?.trim() || "";
}

async function getActiveProject() {
  const { data, error } = await supabase
    .from("story_projects")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getNextEpisode(projectId) {
  const { data, error } = await supabase
    .from("story_episodes")
    .select("episode_no,title,summary,content,status")
    .eq("project_id", projectId)
    .order("episode_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function createEpisode(project, previous) {
  const nextNo = (previous?.episode_no || 0) + 1;

  const prompt = `Buat episode ${nextNo} dari novel serial.

Judul serial: ${project.title}
Premise: ${project.premise}
Genre: ${project.genre}
Tone: ${project.tone}

Story bible:
${JSON.stringify(project.story_bible || {}, null, 2)}

Episode sebelumnya:
${previous ? JSON.stringify(previous, null, 2) : "Belum ada. Ini episode pembuka."}

Aturan:
- Episode harus melanjutkan episode sebelumnya.
- Jangan menutup seluruh konflik utama terlalu cepat.
- Buat hook yang membuat pembaca ingin membaca episode berikutnya.
- Bahasa Indonesia natural.
- Jangan menyebut bahwa teks dibuat AI.
- Keluarkan JSON valid dengan format:
{
  "title": "...",
  "summary": "...",
  "content": "...",
  "next_threads": ["..."],
  "character_updates": {}
}`;

  const raw = await aiGenerate(prompt);
  const clean = raw.replace(/^\`\`\`json\s*/i, "").replace(/\s*\`\`\`$/i, "");

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    parsed = {
      title: `Episode ${nextNo}`,
      summary: clean.slice(0, 500),
      content: clean,
      next_threads: [],
      character_updates: {}
    };
  }

  const { data, error } = await supabase
    .from("story_episodes")
    .insert({
      project_id: project.id,
      episode_no: nextNo,
      title: parsed.title,
      summary: parsed.summary,
      content: parsed.content,
      metadata: {
        next_threads: parsed.next_threads || [],
        character_updates: parsed.character_updates || {}
      },
      status: dryRun ? "draft" : "ready"
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function publishLinkedIn(episode, project) {
  if (dryRun) {
    log("dry_run_publish", { episode_id: episode.id });
    return { id: "dry-run" };
  }

  if (!env.LINKEDIN_ACCESS_TOKEN || !env.LINKEDIN_AUTHOR_URN) {
    throw new Error("LinkedIn credentials are not configured");
  }

  const version = env.LINKEDIN_VERSION || "202610";
  const commentary = [
    `📖 ${project.title} — Episode ${episode.episode_no}: ${episode.title}`,
    "",
    episode.content,
    "",
    `#CeritaBersambung #Novel #KisahCinta #Cerita`
  ].join("\n");

  const response = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINKEDIN_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "Linkedin-Version": version
    },
    body: JSON.stringify({
      author: env.LINKEDIN_AUTHOR_URN,
      commentary,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: []
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false
    })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`LinkedIn API ${response.status}: ${text}`);

  return {
    id: response.headers.get("x-restli-id") || "published",
    response: text
  };
}

async function runOnce() {
  const started = Date.now();
  const { data: run, error: runError } = await supabase
    .from("worker_runs")
    .insert({ status: "running" })
    .select()
    .single();

  if (runError) throw runError;

  try {
    const project = await getActiveProject();
    if (!project) {
      log("no_active_project");
      await supabase.from("worker_runs").update({
        status: "completed",
        finished_at: new Date().toISOString(),
        message: "No active story project"
      }).eq("id", run.id);
      return;
    }

    const previous = await getNextEpisode(project.id);
    const episode = await createEpisode(project, previous);
    log("episode_created", { episode_id: episode.id, episode_no: episode.episode_no });

    if (!dryRun) {
      const published = await publishLinkedIn(episode, project);

      await supabase.from("story_episodes").update({
        status: "published",
        published_at: new Date().toISOString(),
        external_id: published.id
      }).eq("id", episode.id);

      await supabase.from("publish_logs").insert({
        episode_id: episode.id,
        platform: "linkedin",
        status: "published",
        external_id: published.id
      });

      log("published", { episode_id: episode.id, external_id: published.id });
    }

    await supabase.from("worker_runs").update({
      status: "completed",
      finished_at: new Date().toISOString(),
      message: `Finished in ${Date.now() - started}ms`
    }).eq("id", run.id);
  } catch (error) {
    log("worker_error", { error: error.message });
    await supabase.from("worker_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      message: error.message
    }).eq("id", run.id);
  }
}

log("worker_started", {
  interval_minutes: intervalMinutes,
  dry_run: dryRun,
  timezone: env.TIMEZONE || "Asia/Jakarta"
});

await runOnce();
setInterval(runOnce, intervalMinutes * 60 * 1000);

process.on("SIGTERM", () => {
  log("worker_stopping");
  process.exit(0);
});
