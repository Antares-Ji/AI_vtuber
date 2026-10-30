/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.minecraft;

import dev.mcplayeragent.harness.PlayerModelConnection.Backend;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Native player control and model connection settings. Credentials never enter the goal JSON. */
public final class PlayerControlScreen extends Screen {
    private EditBox goal, endpoint, model, key, prompt;
    private Backend backend;
    private boolean chatSummary;
    public PlayerControlScreen() { super(Component.literal("MC Player Agent · 模型连接与提示词")); }
    @Override protected void init() {
        int w = Math.min(420, width - 24), x = (width - w) / 2, y = Math.max(24, (height - 218) / 2);
        backend = PlayerControl.backend();
        chatSummary = PlayerControl.chatSummaryEnabled();
        addRenderableWidget(Button.builder(providerLabel(), b -> {
            backend = backend == Backend.DEEPSEEK ? Backend.OLLAMA : Backend.DEEPSEEK;
            b.setMessage(providerLabel());
            endpoint.setValue(backend == Backend.DEEPSEEK ? "https://api.deepseek.com" : "http://127.0.0.1:11434/v1");
            model.setValue(backend == Backend.DEEPSEEK ? "deepseek-flash" : "qwen3-minecraft:8b");
        }).bounds(x, y, w / 2 - 4, 20).build());
        addRenderableWidget(Button.builder(Component.literal("保存并测试连接"), b -> {
            if (save()) PlayerControl.testConnection();
        }).bounds(x + w / 2 + 4, y, w / 2 - 4, 20).build());
        goal = field(x, y + 34, w, PlayerControl.goal(), "目标", 16000);
        endpoint = field(x, y + 68, w, PlayerControl.endpoint(), "API 地址", 512);
        model = field(x, y + 102, w / 2 - 4, PlayerControl.model(), "模型", 128);
        key = field(x + w / 2 + 4, y + 102, w / 2 - 4, "", "API Key", 1024);
        key.setFormatter((value, start) -> Component.literal("*".repeat(value.length())).getVisualOrderText());
        key.setHint(Component.literal(PlayerControl.hasDeepSeekKey() ? "已保存，留空保留" : "DeepSeek API Key"));
        prompt = field(x, y + 136, w, PlayerControl.extraPrompt(), "附加提示词", 16000);
        addRenderableWidget(Button.builder(summaryLabel(), b -> {
            chatSummary = !chatSummary; b.setMessage(summaryLabel());
        }).bounds(x + w - 108, y + 120, 108, 14).build());
        addRenderableWidget(Button.builder(Component.literal("保存并开始接管"), b -> {
            if (save()) { minecraft.setScreen(null); PlayerControl.start(); }
        }).bounds(x, y + 164, w / 2 - 4, 20).build());
        addRenderableWidget(Button.builder(Component.literal("停止 / 返回"), b -> {
            PlayerControl.stop("手动停止"); minecraft.setScreen(new MissionControlScreen());
        }).bounds(x + w / 2 + 4, y + 164, w / 2 - 4, 20).build());
        setInitialFocus(goal);
    }
    private boolean save() {
        return PlayerControl.configure(goal.getValue(), backend, endpoint.getValue(), model.getValue(), key.getValue(), prompt.getValue(), chatSummary);
    }
    private Component summaryLabel() { return Component.literal("聊天摘要：" + (chatSummary ? "开" : "关")); }
    private Component providerLabel() { return Component.literal(backend == Backend.DEEPSEEK ? "服务商：DeepSeek 官方" : "服务商：本机 Ollama"); }
    private EditBox field(int x, int y, int w, String value, String label, int limit) {
        EditBox box = new EditBox(font, x, y, w, 20, Component.literal(label));
        box.setMaxLength(limit); box.setValue(value); return addRenderableWidget(box);
    }
    @Override public void render(GuiGraphics g, int mx, int my, float partialTick) {
        super.render(g, mx, my, partialTick);
        int w = Math.min(420, width - 24), x = (width - w) / 2, y = Math.max(24, (height - 218) / 2);
        g.drawCenteredString(font, title, width / 2, 9, 0xFFFFFF);
        String world=minecraft.getSingleplayerServer()==null?"单人世界 / 本机局域网房主":minecraft.getSingleplayerServer().getWorldData().getLevelName();
        g.drawString(font, font.plainSubstrByWidth("当前存档独立目标："+world,w), x, y + 24, 0xFFFFFF);
        g.drawString(font, "API 地址", x, y + 58, 0xFFFFFF);
        g.drawString(font, "模型名称", x, y + 92, 0xFFFFFF);
        g.drawString(font, "API Key（仅本机保存）", x + w / 2 + 4, y + 92, 0xFFFFFF);
        g.drawString(font, "附加系统提示词（可留空）", x, y + 126, 0xFFFFFF);
        g.drawString(font, backend == Backend.DEEPSEEK ? "DeepSeek：思考 low · 约5秒检查进度 · F9急停" : "本地模型 · 持续技能 · F9 或人工输入停止", x, y + 190, 0xFFFF80);
        g.drawString(font, font.plainSubstrByWidth(PlayerControl.status(), w), x, y + 202, 0xCCCCCC);
    }
    @Override public boolean isPauseScreen() { return false; }
}
