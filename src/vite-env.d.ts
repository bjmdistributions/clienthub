/// <reference types="vite/client" />

// globe.gl's package.json exports map is missing a "types" entry, so the
// bundler module resolver can't find the type declarations automatically.
// Declaring it here points TypeScript at the correct .d.ts file.
declare module "globe.gl" {
  export { default } from "globe.gl/dist/globe.gl";
}
