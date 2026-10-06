/**
 * Host half of dsh-plugin-default-workspace.
 *
 * The policy this plugin installs is browser-side only: the Workspace a new
 * Session falls back to is chosen by the Client Workspace navigation policy
 * (`uiWorkspace`), which no Host service exposes. This half exists so the
 * package can be mounted as one ordinary Loader entry whose browser half ships
 * through `exports["./client"]`, discovered from the `dsh.client` declaration.
 */
/** Host plugin body — no host-side behavior. */
function apply() {}
export { apply };
