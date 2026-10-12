// A completed upload is not a disconnected response: watch response close.
function responseAbortController(res, parentSignal) {
  const controller = new AbortController();
  const disconnected = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", disconnected);
  res.once("finish", () => res.removeListener("close", disconnected));
  if (res.destroyed) disconnected();
  if (parentSignal) {
    const revoked = () => {
      controller.abort(parentSignal.reason);
      if (!res.writableEnded) res.destroy?.();
    };
    parentSignal.addEventListener("abort", revoked, { once: true });
    const cleanup = () => parentSignal.removeEventListener("abort", revoked);
    res.once("finish", cleanup);
    res.once("close", cleanup);
    if (parentSignal.aborted) revoked();
  }
  return controller;
}

module.exports = { responseAbortController };
