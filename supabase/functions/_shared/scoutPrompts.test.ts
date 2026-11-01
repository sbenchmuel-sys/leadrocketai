// Run: deno test supabase/functions/_shared/scoutPrompts.test.ts
// Scout AI tasks: only known task names dispatch; model replies parse
// (fenced or not); any gateway failure returns null, never throws.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { isScoutTask, parseJsonObject, runScoutTask } from "./scoutPrompts.ts";

Deno.test("isScoutTask: only the three scout tasks", () => {
  assertEquals(["scout_build_profile", "scout_pick_samples", "scout_refine_profile"].every(isScoutTask), true);
  assertEquals(isScoutTask("toString"), false);
  assertEquals(isScoutTask("reply_to_thread"), false);
});

Deno.test("parseJsonObject handles fences and junk", () => {
  assertEquals(parseJsonObject('```json\n{"picks":[]}\n```'), { picks: [] });
  assertEquals(parseJsonObject("no json"), null);
  assertEquals(parseJsonObject("{broken"), null);
  assertEquals(parseJsonObject(null), null);
});

const reply = (content: string, status = 200) => () =>
  Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));

Deno.test("runScoutTask returns the parsed object, or null on failure", async () => {
  const log = console.log, err = console.error;
  console.log = console.error = () => {};
  try {
    const ok = await runScoutTask("k", "scout_pick_samples", {}, reply('{"picks":[{"id":"a"}]}') as typeof fetch);
    assertEquals(ok, { picks: [{ id: "a" }] });
    assertEquals(await runScoutTask("k", "scout_pick_samples", {}, reply("{}", 402) as typeof fetch), null);
    assertEquals(await runScoutTask("", "scout_pick_samples", {}, reply("{}") as typeof fetch), null);
    assertEquals(await runScoutTask("k", "scout_pick_samples", {}, (() => Promise.reject(new Error("x"))) as typeof fetch), null);
  } finally {
    console.log = log;
    console.error = err;
  }
});
