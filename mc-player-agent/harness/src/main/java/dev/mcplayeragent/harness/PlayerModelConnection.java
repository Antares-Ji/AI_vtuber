/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import java.net.URI;
import java.util.List;

/** Provider-specific wire settings without credentials or Minecraft state. */
public record PlayerModelConnection(Backend backend, String endpoint, String model) {
    public enum Backend { OLLAMA, DEEPSEEK }
    public static final Decoder PROVIDER = new Decoder();
    public record Response(String content) {}
    public static final class Decoder {
        public Response parseResponseBody(JsonObject body) {
            var choices=body.getAsJsonArray("choices");
            if(choices==null || choices.isEmpty()) throw new IllegalArgumentException("模型未返回候选答案");
            var choice=choices.get(0).getAsJsonObject();
            if(choice.has("finish_reason") && "length".equals(choice.get("finish_reason").getAsString()))
                throw new IllegalArgumentException("模型输出被截断，请缩小任务");
            var message=choice.getAsJsonObject("message");
            if(message==null || !message.has("content") || message.get("content").isJsonNull())
                throw new IllegalArgumentException("模型未返回动作内容");
            return new Response(message.get("content").getAsString());
        }
    }

    public PlayerModelConnection {
        URI uri = URI.create(endpoint.strip());
        if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null)
            throw new IllegalArgumentException("API 地址不能带凭据、查询参数或片段");
        if (backend == Backend.DEEPSEEK) {
            if (!"https".equals(uri.getScheme()) || !"api.deepseek.com".equalsIgnoreCase(uri.getHost())
                    || uri.getPort() != -1 && uri.getPort() != 443)
                throw new IllegalArgumentException("DeepSeek 官方地址须为 https://api.deepseek.com");
        } else if (!"http".equals(uri.getScheme()) || !("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost()))) {
            throw new IllegalArgumentException("Ollama 须使用本机 HTTP 地址");
        }
        if (model.isBlank()) throw new IllegalArgumentException("模型不能为空");
        endpoint = endpoint.strip().replaceAll("/+$", ""); model = model.strip();
    }
    public String url() { return endpoint.endsWith("/chat/completions") ? endpoint : endpoint + "/chat/completions"; }
    public static String error(Throwable error) {
        while ((error instanceof java.util.concurrent.CompletionException || error instanceof java.util.concurrent.ExecutionException)
                && error.getCause() != null) error = error.getCause();
        if (error instanceof ModelHttpException http) {
            return "HTTP " + http.statusCode() + switch (http.statusCode()) {
                case 401, 403 -> "：API Key 无效或无权访问";
                case 402 -> "：账户余额不足";
                case 429 -> "：请求限流，请稍后重试";
                default -> "：模型接口返回错误";
            };
        }
        if (error instanceof JsonParseException || error instanceof IllegalArgumentException || error instanceof IllegalStateException)
            return "模型回复格式无效，请检查模型与任务";
        return error instanceof java.util.concurrent.TimeoutException ? "模型请求超时" : "网络或连接错误：" + error.getClass().getSimpleName();
    }
    public JsonObject request(String prompt, JsonObject state) {
        JsonObject body=new JsonObject(); body.addProperty("model",model);
        JsonArray messages=new JsonArray();
        JsonObject system=new JsonObject(); system.addProperty("role","system"); system.addProperty("content",prompt); messages.add(system);
        JsonObject user=new JsonObject(); user.addProperty("role","user"); user.addProperty("content",state.toString()); messages.add(user);
        body.add("messages",messages); body.addProperty("max_tokens",backend==Backend.DEEPSEEK?16384:4096);
        body.addProperty("temperature",0.2);
        body.addProperty("stream", false); body.remove("stream_options");
        body.addProperty("reasoning_effort", backend == Backend.DEEPSEEK ? "low" : "none");
        if (backend == Backend.DEEPSEEK) {
            body.remove("temperature");
            JsonObject thinking = new JsonObject(); thinking.addProperty("type", "enabled"); body.add("thinking", thinking);
        }
        JsonObject format = new JsonObject(); format.addProperty("type", "json_object"); body.add("response_format", format);
        return body;
    }
}
