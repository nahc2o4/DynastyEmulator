import { complete as coreComplete, listModels as coreListModels } from "./model-core.mjs";
import { modelFetch, modelNetworkMessage } from "./model-transport.mjs";

export { validateModelConfig, validateCompletionMessage } from "./model-core.mjs";

// Node keeps the verified TLS/proxy transport; browsers import model-core directly.
export async function listModels(rawConfig, fetchImpl = modelFetch) {
  return coreListModels(rawConfig, fetchImpl, modelNetworkMessage);
}
export async function complete(config, messages, tools, fetchImpl = modelFetch) {
  return coreComplete(config, messages, tools, fetchImpl, modelNetworkMessage);
}
