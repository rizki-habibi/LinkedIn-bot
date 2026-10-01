import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type StoryProject = {
  id: string;
  title: string;
  premise: string;
  genre: string;
  tone: string;
  story_bible: Record<string, unknown>;
  interval_minutes: number;
};

type Episode = {
  id: string;
  episode_no: number;
  title: string;
  summary: string;
  content: string;
};

const env = process.env;
const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "AI_API_KEY"] as const;

for (const key of required) {
  if (!env[key]) throw new Error(`Missing environment variable: ${key}`);
}

const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const dryRun = (env.DRY_RUN ?? "true").toLowerCase() === "true";
const defaultInterval = Math.max(5, Number(env.POST_INTERVAL_MINUTES ?? 60));
let running = false;

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

async function aiGenerate(prompt: string): Promise<string> {
  const base = (env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.AI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.AI_MODEL ?? "gpt-5.6-mini",
      temperature: 0.85,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Kamu adalah showrunner novel serial. Jaga kontinuitas karakter, timeline, lokasi, konflik dan gaya. Buat cerita emosional, orisinal, aman, dan tidak menyebut AI."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) throw new Error(`AI API ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

async function getActiveProject(): Promise<StoryProject | null> {
  const { data, error } = await supabase
    .from("story_projects")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as StoryProject | null;
}

async function getLatestEpisode(projectId: string): Promise<Episode | null> {
  const { data, error } = await supabase
    .from("story_episodes")
    .select("id,episode_no,title,summary,content")
    .eq("project_id", projectId)
    .order("episode_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as Episode | null;
}

async function createEpisode(project: StoryProject, previous: Episode | null): Promise<Episode> {
  const nextNo = (previous?.episode_no ?? 0) + 1;
  const prompt = `Buat episode ${nextNo} dari novel serial berikut.

Judul: ${project.title}
Premise: ${project.premise}
Genre: ${project.genre}
Tone: ${project.tone}

Story bible:
${JSON.stringify(project.story_bible, null, 2)}

Episode sebelumnya:
${previous ? JSON.stringify(previous, null, 2) : "Belum ada. Ini episode pertama."}

Buat satu episode yang terasa seperti bab novel, bukan ringkasan. Bangun emosi dan konflik secara bertahap. Akhiri dengan hook yang membuat pembaca menunggu episode berikutnya.

Kembalikan JSON:
{
  "title": "judul episode",
  "summary": "ringkasan 2-3 kalimat",
  "content": "isi episode lengkap",
  "next_threads": ["konflik atau pertanyaan yang harus dibawa ke episode berikutnya"],
  "character_updates": {}
}`;

  const raw = await aiGenerate(prompt);
  const parsed = JSON.parse(raw) as {
    title: string;
    summary: string;
    content: string;
    next_threads?: string[];
    character_updates?: Record<string, unknown>;
  };

  const { data, error } = await supabase
    .from("story_episodes")
    .insert({
      project_id: project.id,
      episode_no: nextNo,
      title: parsed.title,
      summary: parsed.summary,
      content: parsed.content,
      metadata: {
        next_threads: parsed.next_threads ?? [],
        character_updates: parsed.character_updates ?? {}
      },
      status: dryRun ? "draft" : "ready"
    })
    .select("id,episode_no,title,summary,content")
    .single();

  if (error) throw error;
  return data as Episode;
}

async function publishLinkedIn(project: StoryProject, episode: Episode): Promise<string> {
  if (dryRun) {
    log("dry_run_publish", { episodeId: episode.id, platform: "linkedin" });
    return "dry-run";
  }

  if (!env.LINKEDIN_ACCESS_TOKEN || !env.LINKEDIN_AUTHOR_URN) {
    throw new Error("LINKEDIN_ACCESS_TOKEN/LINKEDIN_AUTHOR_URN belum dikonfigurasi");
  }

  const commentary = [
    `📖 ${project.title} — Episode ${episode.episode_no}: ${episode.title}`,
    "",
    episode.content,
    "",
    "#CeritaBersambung #Novel #KisahCinta #Cerita"
  ].join("\n");

  const response = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINKEDIN_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "Linkedin-Version": env.LINKEDIN_VERSION ?? "202610"
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

  const responseText = await response.text();
  if (!response.ok) throw new Error(`LinkedIn API ${response.status}: ${responseText}`);

  return response.headers.get("x-restli-id") ?? "published";
}

async function runOnce(): Promise<void> {
  if (running) {
    log("skip_overlap");
    return;
  }

  running = true;
  const started = Date.now();

  try {
    const project = await getActiveProject();
    if (!project) {
      log("no_active_project");
      return;
    }

    const { data: run, error: runError } = await supabase
      .from("worker_runs")
      .insert({ project_id: project.id, status: "running" })
      .select("id")
      .single();

    if (runError) throw runError;

    try {
      const previous = await getLatestEpisode(project.id);
      const episode = await createEpisode(project, previous);
      log("episode_created", { episodeId: episode.id, episodeNo: episode.episode_no });

      if (!dryRun) {
        const externalId = await publishLinkedIn(project, episode);

        await supabase.from("story_episodes").update({
          status: "published",
          published_at: new Date().toISOString(),
          external_id: externalId
        }).eq("id", episode.id);

        await supabase.from("publish_logs").insert({
          episode_id: episode.id,
          platform: "linkedin",
          status: "published",
          external_id: externalId
        });

        log("published", { episodeId: episode.id, externalId });
      }

      await supabase.from("worker_runs").update({
        status: "completed",
        finished_at: new Date().toISOString(),
        message: `completed in ${Date.now() - started}ms`
      }).eq("id", run.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("worker_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        message
      }).eq("id", run.id);
      log("run_failed", { error: message });
    }
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  log("worker_started", {
    mode: dryRun ? "DRY_RUN" : "LIVE",
    defaultIntervalMinutes: defaultInterval,
    timezone: env.TIMEZONE ?? "Asia/Jakarta"
  });

  await runOnce();

  const tick = async () => {
    try {
      await runOnce();
    } catch (error) {
      log("tick_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  setInterval(tick, defaultInterval * 60_000);
}

process.on("SIGTERM", () => {
  log("worker_stopping");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("worker_stopping");
  process.exit(0);
});

void main();
