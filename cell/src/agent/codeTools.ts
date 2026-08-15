/**
 * Server-only source-code tools for the investigator.
 *
 * Lazy checkout (S3 design): the agent calls `checkout_repo` once
 * telemetry has narrowed to a service, then reads the tree with
 * `list_dir` / `read_file` / `grep_code`. All read-only, scoped to the
 * checked-out repos in the DO's RepoStore. Never wired into the browser
 * client Investigator — code lives only on the cell.
 */
import type { AgentToolDefinition } from '@cribl/app-utils/agent';
import type { ToolCallInvocation, ToolExecutionResult } from '../../../src/api/agentTools';
import type { RepoStore } from '../workspace/repoStore';
import { checkoutRepo, resolveRepoForService, type RepoConfig } from '../workspace/checkout';

const MAX_READ_CHARS = 60_000;

export const CODE_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    id: 'checkout_repo',
    description:
      "Check out a service's source repository so you can read it. Call this only after telemetry has pointed at a specific service. Give either the service name (it maps to the configured repo, falling back to the monorepo catch-all) or an explicit repo name. Returns the repo name to use with the other code tools, and writes RECENT_COMMITS.md with the latest changes.",
    schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'The implicated service; resolves to its configured repo (or the catch-all monorepo).',
        },
        repo: {
          type: 'string',
          description: 'Optional explicit repo name from the configured list (overrides service mapping).',
        },
      },
    },
  },
  {
    id: 'list_dir',
    description: 'List the immediate contents of a directory in a checked-out repo. Directories end with "/".',
    schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name returned by checkout_repo.' },
        path: { type: 'string', description: 'Directory path within the repo; empty/"." for the root.' },
      },
      required: ['repo'],
    },
  },
  {
    id: 'read_file',
    description: 'Read a file from a checked-out repo. Read RECENT_COMMITS.md for what changed lately. Output is truncated if very large.',
    schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name returned by checkout_repo.' },
        path: { type: 'string', description: 'File path within the repo.' },
      },
      required: ['repo', 'path'],
    },
  },
  {
    id: 'grep_code',
    description: 'Search a checked-out repo for a regular expression, returning file:line matches. Use this to find where a symbol, error string, or config key is defined or used.',
    schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name returned by checkout_repo.' },
        pattern: { type: 'string', description: 'A JavaScript regular expression to match per line.' },
        path: { type: 'string', description: 'Optional path prefix to scope the search.' },
      },
      required: ['repo', 'pattern'],
    },
  },
];

export const CODE_TOOL_NAMES: ReadonlySet<string> = new Set(
  CODE_TOOL_DEFINITIONS.map((d) => d.id),
);

/** Seed-prompt addendum (server-only) telling the agent when/how to use
 *  the code tools and which repos are configured. */
export function codeToolsAddendum(repos: RepoConfig[]): string {
  const list = repos
    .map((r) => {
      const name = r.name ?? r.url;
      const scope =
        r.service && r.service !== '*' ? `service: ${r.service}` : 'any service / monorepo';
      return `- \`${name}\` (${scope})`;
    })
    .join('\n');
  return `

### Source code (available when telemetry has narrowed to a service)

You can read the implicated service's source. Once you know which service
is at fault, call \`checkout_repo\` (pass the service name), then use
\`read_file\` / \`list_dir\` / \`grep_code\`. Read \`RECENT_COMMITS.md\` for
what changed lately. **Consult code only after telemetry points at a
specific service** — don't open code speculatively. Cite exact file paths
and line numbers in your findings. Configured repos:
${list}
`;
}

export interface CodeToolDeps {
  store: RepoStore;
  repos: RepoConfig[];
  /** Cell GitHub token for private repos (optional). */
  token?: string;
  /** The investigation's implicated service, used as checkout_repo's
   *  default when the agent omits `service`. */
  targetService?: string;
}

export function createCodeToolExecutors(deps: CodeToolDeps): {
  names: ReadonlySet<string>;
  executeToolCall(call: ToolCallInvocation): Promise<ToolExecutionResult>;
} {
  async function executeToolCall(call: ToolCallInvocation): Promise<ToolExecutionResult> {
    const args = (() => {
      try {
        return JSON.parse(call.arguments || '{}') as Record<string, string | undefined>;
      } catch {
        return {};
      }
    })();
    const done = (content: string): ToolExecutionResult => ({
      id: call.id,
      name: call.name,
      content,
    });

    switch (call.name) {
      case 'checkout_repo': {
        const service = args.service ?? deps.targetService;
        const resolved = resolveRepoForService(deps.repos, service, args.repo);
        if (!resolved) {
          const configured = deps.repos.map((r) => r.name ?? r.url).join(', ') || '(none)';
          return done(
            `No configured repo for service "${service ?? ''}"${args.repo ? ` / name "${args.repo}"` : ''}. Configured repos: ${configured}.`,
          );
        }
        if (deps.store.hasRepo(resolved.name)) {
          return done(`Repo "${resolved.name}" is already checked out. Use list_dir/read_file/grep_code with repo="${resolved.name}".`);
        }
        try {
          const stats = await checkoutRepo(deps.store, resolved, deps.token);
          return done(
            `Checked out "${resolved.name}" (${resolved.owner}/${resolved.repo}${resolved.ref ? `@${resolved.ref}` : ''}): ${stats.stored} files` +
              `${stats.truncated ? ' (truncated at the file cap)' : ''}. Read RECENT_COMMITS.md for recent changes. ` +
              `Use list_dir/read_file/grep_code with repo="${resolved.name}".`,
          );
        } catch (err) {
          return done(`checkout failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case 'list_dir': {
        const repo = args.repo ?? '';
        if (!deps.store.hasRepo(repo)) return done(`Repo "${repo}" is not checked out. Call checkout_repo first.`);
        const children = deps.store.listDir(repo, args.path ?? '');
        return done(children.length ? children.join('\n') : '(empty)');
      }
      case 'read_file': {
        const repo = args.repo ?? '';
        const content = deps.store.readFile(repo, args.path ?? '');
        if (content == null) return done(`File not found: "${args.path}" in "${repo}".`);
        return done(content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n… (truncated)` : content);
      }
      case 'grep_code': {
        const repo = args.repo ?? '';
        if (!deps.store.hasRepo(repo)) return done(`Repo "${repo}" is not checked out. Call checkout_repo first.`);
        const { matches, truncated } = deps.store.grep(repo, args.pattern ?? '', { pathPrefix: args.path });
        const out = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
        return done(`${out || '(no matches)'}${truncated ? '\n… (more matches omitted)' : ''}`);
      }
      default:
        return done(`unknown code tool: ${call.name}`);
    }
  }

  return { names: CODE_TOOL_NAMES, executeToolCall };
}
