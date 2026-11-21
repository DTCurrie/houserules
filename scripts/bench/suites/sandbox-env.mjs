import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The environment every bench case runs under, so no case reaches `~/.claude`, a GitHub token,
 * or the network. Merge a suite's own keys, such as `CLAUDE_PROJECT_DIR`, over the result.
 *
 * @param {string} home A fixture directory that stands in for `HOME`.
 */
export function sandboxEnv(home) {
  return {
    HOME: home,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    // `doctor` asks npm for the published `latest` unless update-notifier's opt-out is set.
    NO_UPDATE_NOTIFIER: '1',
    // pnpm 11 reads only `pnpm_config_*`. Its daily update check hits the registry otherwise.
    pnpm_config_update_notifier: 'false',
    pnpm_config_offline: 'true',
    // pnpm runs through corepack, whose cache lives under HOME. Keep the real cache and forbid
    // downloads, so a cold cache fails the case instead of reaching the registry.
    COREPACK_HOME:
      process.env.COREPACK_HOME ||
      join(homedir(), '.cache', 'node', 'corepack'),
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
  };
}
