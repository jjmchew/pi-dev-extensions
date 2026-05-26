/**
 * Git Gate Extension
 *
 * Denies selected git/GitHub commands from pi bash execution.
 *
 * Blocked:
 * - git push
 * - git reset
 * - GitHub CLI commands that write PR/issue comments or reviews
 * - GitHub API/curl calls that appear to create PR/issue comments/reviews
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface BlockRule {
	name: string;
	pattern: RegExp;
	reason: string;
}

const commandBoundary = String.raw`(?:^|[\s;&|()])`;
const gitWithOptionalArgs = String.raw`git(?:\s+-\S+(?:\s+\S+)?)?`;
const ghWithOptionalRepo = String.raw`gh(?:\s+--repo\s+\S+|\s+-R\s+\S+)?`;

const blockRules: BlockRule[] = [
	{
		name: "git-push",
		pattern: new RegExp(`${commandBoundary}${gitWithOptionalArgs}\s+push\b`, "i"),
		reason: "git push is denied",
	},
	{
		name: "git-reset",
		pattern: new RegExp(`${commandBoundary}${gitWithOptionalArgs}\s+reset\b`, "i"),
		reason: "git reset is denied",
	},
	{
		name: "git-clean",
		pattern: new RegExp(`${commandBoundary}${gitWithOptionalArgs}\s+clean\b`, "i"),
		reason: "git clean is denied",
	},
	{
		name: "gh-pr-comment",
		pattern: new RegExp(`${commandBoundary}${ghWithOptionalRepo}\s+pr\s+comment\b`, "i"),
		reason: "writing PR comments with gh pr comment is denied",
	},
	{
		name: "gh-issue-comment",
		pattern: new RegExp(`${commandBoundary}${ghWithOptionalRepo}\s+issue\s+comment\b`, "i"),
		reason: "writing issue/PR comments with gh issue comment is denied",
	},
	{
		name: "gh-pr-review",
		pattern: new RegExp(`${commandBoundary}${ghWithOptionalRepo}\s+pr\s+review\b`, "i"),
		reason: "writing PR reviews/comments with gh pr review is denied",
	},
	{
		name: "gh-api-rest-comments",
		pattern: new RegExp(
			`${commandBoundary}${ghWithOptionalRepo}\s+api\b(?=[\s\S]*(?:POST|--method\s+(?:POST|PATCH|PUT)|-X\s*(?:POST|PATCH|PUT)))(?=[\s\S]*repos/[^\s]+/[^\s]+/(?:issues|pulls)/[^\s]+/comments)`,
			"i",
		),
		reason: "writing PR/issue comments through gh api is denied",
	},
	{
		name: "gh-api-graphql-comments",
		pattern: new RegExp(`${commandBoundary}${ghWithOptionalRepo}\s+api\s+graphql\b(?=[\s\S]*(?:addComment|addPullRequestReview|addPullRequestReviewComment))`, "i"),
		reason: "writing PR comments/reviews through GitHub GraphQL is denied",
	},
	{
		name: "curl-github-comments",
		pattern: new RegExp(
			`${commandBoundary}curl\b(?=[\s\S]*(?:api\.github\.com|github\.com/api/v3))(?=[\s\S]*(?:-X\s*(?:POST|PATCH|PUT)|--request\s+(?:POST|PATCH|PUT)))(?=[\s\S]*/repos/[^\s]+/[^\s]+/(?:issues|pulls)/[^\s]+/comments)`,
			"i",
		),
		reason: "writing PR/issue comments through GitHub API is denied",
	},
];

function findBlockedRule(command: string): BlockRule | undefined {
	return blockRules.find((rule) => rule.pattern.test(command));
}

function blockMessage(command: string, rule: BlockRule): string {
	return `Blocked by git-gate (${rule.name}): ${rule.reason}\n\nCommand:\n${command}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string | undefined;
		if (!command) return undefined;

		const blockedRule = findBlockedRule(command);
		if (!blockedRule) return undefined;

		const reason = blockMessage(command, blockedRule);
		if (ctx.hasUI) ctx.ui.notify(reason, "warning");

		return { block: true, reason };
	});

	pi.on("user_bash", (event, ctx) => {
		const blockedRule = findBlockedRule(event.command);
		if (!blockedRule) return undefined;

		const output = blockMessage(event.command, blockedRule);
		if (ctx.hasUI) ctx.ui.notify(output, "warning");

		return {
			result: {
				output,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
