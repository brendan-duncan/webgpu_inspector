export function getStacktrace() {
  if (!Error.captureStackTrace) {
    return "";
  }
  const stacktrace = {};
  Error.captureStackTrace(stacktrace, getStacktrace);
  if (!stacktrace.stack) {
    return "";
  }
  let stack = stacktrace.stack
    .split("\n")
    .map((line) => line.split("at ")[1])
    .slice(2) // Skip the Error line and the GPU.* line.
    .filter((line) => line && !line.includes("webgpu_inspector.js"));

  return stack.join("\n");
}
