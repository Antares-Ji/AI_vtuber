/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;
/** HTTP errors intentionally exclude response bodies and credentials. */
public final class ModelHttpException extends RuntimeException {
    private final int statusCode;
    public ModelHttpException(int statusCode,String ignoredBody,String host) {
        super("Model endpoint returned HTTP "+statusCode); this.statusCode=statusCode;
    }
    public int statusCode() { return statusCode; }
}
