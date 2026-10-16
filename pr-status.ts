/**
 * PR Status Extension
 *
 * Shows the current branch's GitHub PR number in the footer via ctx.ui.setStatus().
 * Requires the `gh` CLI (authenticated). Hidden when there's no repo/branch/PR.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let lastBranch: string | undefined;

	async function refresh(ctx: ExtensionContext, force = false) {
		try {
			const br = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 2000 });
			const branch = br.code === 0 ? br.stdout.trim() : "";
			if (!force && branch === lastBranch) return;
			lastBranch = branch;

			if (!branch) return ctx.ui.setStatus("pr", undefined);

			const r = await pi.exec("gh", ["pr", "view", "--json", "number,state"], { cwd: ctx.cwd, timeout: 5000 });
			if (r.code !== 0) return ctx.ui.setStatus("pr", undefined); // no PR for this branch

			const { number, state } = JSON.parse(r.stdout) as { number: number; state: string };
			const t = ctx.ui.theme;
			const color = state === "OPEN" ? "success" : state === "MERGED" ? "accent" : "dim";
			ctx.ui.setStatus("pr", t.fg(color, `PR #${number}`));
		} catch {
			ctx.ui.setStatus("pr", undefined);
		}
	}

	pi.on("session_start", (_e, ctx) => refresh(ctx, true));
	pi.on("agent_end", (_e, ctx) => refresh(ctx));
}
