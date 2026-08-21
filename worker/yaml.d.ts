/**
 * `agent.example.yaml` is bundled as a string by the wrangler `Text` rule, so
 * the Worker always ships with a valid fallback config even before anything is
 * written to KV.
 */
declare module "*.yaml" {
  const content: string;
  export default content;
}
