import type { HostRpc } from "@pi-desktop/host-runtime";
import { isActiveInProject, type UserSkillRecord } from "@pi-desktop/shared";

export type SkillToolResult = { ok: boolean; isError?: boolean; content: string };

/**
 * The headless `Skill` tool: load one of the user's skill documents by id.
 *
 * `skills.read` resolves any document on disk, including a project skill the
 * user has not approved or one switched off, because Settings reads those for
 * review. Only a skill that is active for the session's project may reach the
 * model, the same rule the launch catalog applies, so a planted or disabled
 * document cannot be loaded by guessing its id.
 */
export async function runSkillTool(
  host: HostRpc | null | undefined,
  args: unknown,
  sessionId: string,
): Promise<SkillToolResult> {
  const id = String((args as { id?: unknown })?.id ?? "").trim();
  if (!id || !host) return { ok: false, isError: true, content: "Skill: `id` is required." };
  const session = await host
    .call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 })
    .catch(() => null);
  const projectPath = session?.session?.projectPath ?? null;
  const result = await host
    .call<{ skill: UserSkillRecord | null; body: string | null }>("skills.read", { id, projectPath })
    .catch(() => null);
  if (!result?.skill || typeof result.body !== "string" || !isActiveInProject(result.skill, projectPath)) {
    return { ok: false, isError: true, content: `Skill: "${id}" is not available on this Host.` };
  }
  return { ok: true, content: `# Skill: ${result.skill.name} (${result.skill.id})\n\n${result.body}` };
}
