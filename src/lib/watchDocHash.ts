/**
 * Identity of the document the app last applied from the watch server.
 *
 * The watch server stamps the project payload with a content hash; the app
 * echoes that hash in its measurements so a tool can tell "this tab is showing
 * the file I am asking about" from "this tab is one version behind".
 */
let watchedDocHash: string | null = null

export function setWatchedDocHash(hash: string | null): void {
  watchedDocHash = hash
}

export function getWatchedDocHash(): string | null {
  return watchedDocHash
}
