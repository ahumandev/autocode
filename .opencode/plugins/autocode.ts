/**
 * Local dev shim — NOT part of the published plugin.
 *
 * Imports the built plugin from dist/ so opencode picks up the real source.
 * Run `bun run watch` in the project root to rebuild on every change.
 *
 * Users of the published npm package never see this file.
 */
export { default } from "../../dist/plugin.js"
