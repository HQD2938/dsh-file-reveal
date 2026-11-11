/**
 * dsh-file-reveal — Host half.
 *
 * The feature lives entirely in the browser half (`./client`): the click
 * handling and path resolution run in the page, and native opening is delegated
 * to the shipped Session Remote `openWorkspacePath`, which the Host already
 * owns. This module only has to exist so the profile Loader accepts the row and
 * `dsh-client-modules` composes the `dsh.client` bundle.
 */

export const name = 'dsh-file-reveal'

export function apply() {
  // Intentionally empty: the Host provides every native capability already.
}
