import { createClient } from "@supabase/supabase-js";

type StoryProject = {
  id: string; title: string; premise: string; genre: string; tone: string;
  story_bible: Record<string, unknown>; interval_minutes: number;
};
type Episode = { id: string; episode_no: number; title: string; summary: string; content: string };

for (const key of ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","AI_API_KEY"] as const) {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
}
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() === "true";
const interval = Math.max(5, Number(process.env.POST_INTERVAL_MINUTES ?? 60));
let running = false;
const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

async function aiGenerate(prompt: string): Promise<string> {
  const base = (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.AI_MODEL ?? "gpt-5.6-mini",
      temperature: 0.85,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Kamu adalah showrunner novel serial. Jaga kontinuitas karakter, timeline, lokasi, konflik dan gaya. Buat cerita orisinal, emosional, aman, dan jangan menyebut AI." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!res.ok) throw new Error(`AI API ${res.status}: ${await res.text()}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

async function activeProject(): Promise<StoryProject | null> {
  const { data, error } = await supabase.from("story_projects").select("*")
    .eq("active", true).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  return data as StoryProject | null;
}

async function latestEpisode(projectId: string): Promise<Episode | null> {
  const { data, error } = await supabase.from("story_episodes")
    .select("id,episode_no,title,summary,content").eq("project_id", projectId)
    .order("episode_no", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data as Episode | null;
}

async function generateEpisode(project: StoryProject, previous: Episode | null): Promise<Episode> {
  const no = (previous?.episode_no ?? 0) + 1;
  const prompt = `Buat episode ${no} dari novel serial.

Judul: ${project.title}
Premise: ${project.premise}
Genre: ${project.genre}
Tone: ${project.tone}

Story bible:
${JSON.stringify(project.story_bible, null, 2)}

Episode sebelumnya:
${previous ? JSON.stringify(previous, null, 2) : "Belum ada. Ini episode pertama."}

Buat seperti bab novel yang utuh, bukan ringkasan. Bangun emosi perlahan, beri konflik kecil, dan akhiri hook.
JSON:
{"title":"...","summary":"...","content":"...","next_threads":["..."],"character_updates":{}}`;
  const parsed = JSON.parse(await aiGenerate(prompt)) as {
    title: string; summary: string; content: string; next_threads?: string[];
    character_updates?: Record<string, unknown>;
  };
  const { data, error } = await supabase.from("story_episodes").insert({
    project_id: project.id, episode_no: no, title: parsed.title, summary: parsed.summary,
    content: parsed.content, metadata: {
      next_threads: parsed.next_threads ?? [],
      character_updates: parsed.character_updates ?? {}
    }, status: dryRun ? "draft" : "ready"
  }).select("id,episode_no,title,summary,content").single();
  if (error) throw error;
  return data as Episode;
}

async function publishLinkedIn(project: StoryProject, episode: Episode): Promise<string> {
  if (dryRun) return "dry-run";
  if (!process.env.LINKEDIN_ACCESS_TOKEN || !process.env.LINKEDIN_AUTHOR_URN)
    throw new Error("LinkedIn credentials belum dikonfigurasi");
  const res = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "Linkedin-Version": process.env.LINKEDIN_VERSION ?? "202610"
    },
    body: JSON.stringify({
      author: process.env.LINKEDIN_AUTHOR_URN,
      commentary: `📖 ${project.title} — Episode ${episode.episode_no}: ${episode.title}\n\n${episode.content}\n\n#CeritaBersambung #Novel #KisahCinta #Cerita`,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false
    })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${body}`);
  return res.headers.get("x-restli-id") ?? "published";
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const project = await activeProject();
    if (!project) return;
    const { data: run, error: runError } = await supabase.from("worker_runs")
      .insert({ project_id: project.id, status: "running" }).select("id").single();
    if (runError) throw runError;
    try {
      const episode = await generateEpisode(project, await latestEpisode(project.id));
      log("episode_created", { episodeId: episode.id, episodeNo: episode.episode_no });
      if (!dryRun) {
        const externalId = await publishLinkedIn(project, episode);
        await supabase.from("story_episodes").update({
          status: "published", published_at: new Date().toISOString(), external_id: externalId
        }).eq("id", episode.id);
        await supabase.from("publish_logs").insert({
          episode_id: episode.id, platform: "linkedin", status: "published", external_id: externalId
        });
        log("published", { episodeId: episode.id, externalId });
      } else log("dry_run_publish", { episodeId: episode.id });
      await supabase.from("worker_runs").update({
        status: "completed", finished_at: new Date().toISOString(), message: "OK"
      }).eq("id", run.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await supabase.from("worker_runs").update({
        status: "failed", finished_at: new Date().toISOString(), message
      }).eq("id", run.id);
      log("run_failed", { error: message });
    }
  } finally { running = false; }
}

log("worker_started", { mode: dryRun ? "DRY_RUN" : "LIVE", intervalMinutes: interval, timezone: process.env.TIMEZONE ?? "Asia/Jakarta" });
await runOnce();
setInterval(() => void runOnce(), interval * 60_000);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
