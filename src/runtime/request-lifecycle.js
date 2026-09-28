// A completed upload is not a disconnected response: watch response close.
function responseAbortController(res) {
  const controller = new AbortController();
  const disconnected = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", disconnected);
  res.once("finish", () => res.removeListener("close", disconnected));
  if (res.destroyed) disconnected();
  return controller;
}

module.exports = { responseAbortController };
