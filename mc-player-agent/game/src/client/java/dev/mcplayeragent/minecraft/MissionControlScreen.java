/* SPDX-License-Identifier: LGPL-3.0-only
 * MC Player Agent task console, implemented in the independent project.
 */
package dev.mcplayeragent.minecraft;

import com.google.gson.JsonObject;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.*;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Task-first UI: one world, one goal, actual execution receipts, explicit completion status. */
public final class MissionControlScreen extends Screen {
    private EditBox goal;
    private int left,top,panel;
    private boolean hasWorld;
    public MissionControlScreen() { super(Component.literal("MC Player Agent · 任务控制台")); }
    @Override protected void init() {
        panel=Math.min(500,width-24);left=(width-panel)/2;top=Math.max(30,(height-224)/2);
        hasWorld=minecraft.player!=null&&minecraft.getSingleplayerServer()!=null;
        goal=new EditBox(font,left+12,top+39,panel-24,22,Component.literal("本存档任务"));
        goal.setMaxLength(16000);
        try { goal.setValue(PlayerControl.goal()); } catch(RuntimeException e) { goal.setValue("请先检查存档记忆日志"); hasWorld=false; }
        addRenderableWidget(goal);
        int half=(panel-32)/2;
        var start=addRenderableWidget(Button.builder(Component.literal("执行任务"),b->{
            if(PlayerControl.configureGoal(goal.getValue())) {
                minecraft.setScreen(null);PlayerControl.start();
            }
        }).bounds(left+12,top+70,half,20).build());start.active=hasWorld;
        addRenderableWidget(Button.builder(Component.literal("停止并交还控制"),b->PlayerControl.stop("任务控制台手动停止"))
                .bounds(left+20+half,top+70,half,20).build());
        addRenderableWidget(Button.builder(Component.literal("模型连接与提示词"),b->{
            PlayerControl.configureGoal(goal.getValue());
            minecraft.setScreen(new PlayerControlScreen());
        }).bounds(left+12,top+184,half,20).build());
        addRenderableWidget(Button.builder(Component.literal("返回游戏"),b->onClose()).bounds(left+20+half,top+184,half,20).build());
        setInitialFocus(goal);
    }
    private void line(GuiGraphics g,String text,int y,int color) { g.drawString(font,font.plainSubstrByWidth(text,panel-24),left+12,top+y,color); }
    private static long number(JsonObject data,String name) { return data.has(name)?data.get(name).getAsLong():0; }
    private static String text(JsonObject data,String name,String fallback) { return data.has(name)?data.get(name).getAsString():fallback; }
    @Override public void render(GuiGraphics g,int mx,int my,float delta) {
        renderBackground(g,mx,my,delta);
        g.fill(left,top,left+panel,top+214,0xEE101A24);
        g.fill(left,top,left+3,top+214,0xFF42CBB3);
        g.drawCenteredString(font,title,width/2,top-20,0xFFFFFF);
        String world=hasWorld?minecraft.getSingleplayerServer().getWorldData().getLevelName():"请进入单人世界或本机局域网房主世界";
        line(g,"当前存档："+world,10,0x86DCCD);
        line(g,"任务目标",27,0xD8E1EC);
        var data=MissionRecording.view();
        String state=text(data,"state","NONE");
        String label=switch(state) { case "RUNNING"->"执行中";case "VERIFIED"->"已通过本地验收";case "UNVERIFIED"->"模型报告完成，尚未验收";case "INTERRUPTED"->"已中断，可调整目标后继续";default->"本存档尚无本次启动后的任务记录"; };
        line(g,"任务结果："+label,103,state.equals("VERIFIED")?0x66E3B4:0xE4D69C);
        line(g,"动作 "+number(data,"steps")+"  |  成功 "+number(data,"successful_steps")+"  |  失败 "+number(data,"failed_steps")+"  |  未确认 "+number(data,"unconfirmed_steps"),119,0xCCD7E4);
        line(g,"模型调用 "+number(data,"model_requests")+" 次  |  平均响应 "+number(data,"average_model_ms")+" ms",135,0xCCD7E4);
        String warning=text(data,"record_problem","");
        line(g,warning.isEmpty()?"当前状态："+PlayerControl.status():warning,151,warning.isEmpty()?0xCCD7E4:0xFF8888);
        line(g,"记录：当前存档/mcplayeragent/runs/ · F9 或人工输入停止",167,0x91A6BD);
        // Keep controls above the console panel.
        for(var child:children())
            if(child instanceof net.minecraft.client.gui.components.Renderable widget) widget.render(g,mx,my,delta);
    }
    @Override public void onClose() { minecraft.setScreen(null); }
    @Override public boolean isPauseScreen() { return false; }
}
