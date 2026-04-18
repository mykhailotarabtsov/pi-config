/**
 * Fun Working Message Extension
 *
 * Replaces the default "Working..." status with a random funny message
 * from a curated list each turn.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const messages = [
  "Consulting the void...",
  "Bribing the compiler...",
  "Teaching old code new tricks...",
  "Asking the rubber duck...",
  "Summoning the code demons...",
  "Reading the tea leaves...",
  "Herding cats...",
  "Dividing by zero (safely)...",
  "Reticulating splines...",
  "Convincing electrons to behave...",
  "Mining bitcoins... kidding!",
  "Calculating the meaning of life...",
  "Optimizing the flux capacitor...",
  "Downloading more RAM...",
  "Untangling spaghetti code...",
  "Negotiating with dependencies...",
  "Reverse engineering the universe...",
  "Polishing pixels...",
  "Transcoding reality...",
  "Debugging the matrix...",
  "Overclocking brain cells...",
  "Quantum tunneling through bugs...",
  "Applying duct tape to pointers...",
  "Refactoring your expectations...",
  "Waiting for heat death of universe...",
  "Compiling excuses...",
  "Generating plausible deniability...",
  "Converting caffeine to code...",
  "Initializing genius mode...",
  "Sacrificing to the demo gods...",
];

export default function (pi: ExtensionAPI) {
  let rng: () => number;

  pi.on("session_start", async (_event, ctx) => {
    // Use crypto random if available, fallback to Math.random
    try {
      const crypto = await import("node:crypto");
      rng = () => {
        const hex = crypto.randomBytes(4).toString("hex");
        return parseInt(hex, 16) / 0xffffffff;
      };
    } catch {
      rng = Math.random;
    }

    ctx.ui.setWorkingMessage(randomMessage());
  });

  pi.on("turn_start", async (_event, ctx) => {
    ctx.ui.setWorkingMessage(randomMessage());
  });

  pi.on("turn_end", async (_event, ctx) => {
    // Reset to default "Working..." when turn ends
    ctx.ui.setWorkingMessage("");
  });

  function randomMessage(): string {
    const index = Math.floor(rng() * messages.length);
    return messages[index];
  }
}
