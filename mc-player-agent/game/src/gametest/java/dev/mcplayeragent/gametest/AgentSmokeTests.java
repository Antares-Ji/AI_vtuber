/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.gametest;
import dev.mcplayeragent.skills.PlayerPickupWatch;
import com.mojang.authlib.GameProfile;
import net.minecraft.gametest.framework.*;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.*;
import net.minecraft.network.*;
import net.minecraft.network.protocol.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.*;
import net.minecraft.world.level.block.Rotation;
import java.util.*;
/** Development-only tests load the standalone mod and exercise its real playerTouch mixin. */
public final class AgentSmokeTests {
    @GameTestGenerator
    public static Collection<TestFunction> tests() {
        return List.of(test("partial_pickup",AgentSmokeTests::partial),test("component_mismatch",AgentSmokeTests::components),
                test("player_isolation",AgentSmokeTests::isolation));
    }
    private static TestFunction test(String name,java.util.function.Consumer<GameTestHelper> run) {
        return new TestFunction("mcplayeragent","mcplayeragent."+name,"mcplayeragent:empty",Rotation.NONE,
                100,0L,true,false,1,1,false,run);
    }
    private static ServerPlayer player(GameTestHelper h) {
        var profile=new GameProfile(UUID.randomUUID(),"agent-test");
        var cookie=CommonListenerCookie.createInitial(profile,false);
        var p=new ServerPlayer(h.getLevel().getServer(),h.getLevel(),profile,cookie.clientInformation());
        var connection=new Connection(PacketFlow.SERVERBOUND) {
            @Override public void send(Packet<?> packet,PacketSendListener listener,boolean flush) {}
        };
        new io.netty.channel.embedded.EmbeddedChannel(connection);
        p.connection=new ServerGamePacketListenerImpl(h.getLevel().getServer(),connection,p,cookie);
        var at=h.absolutePos(new BlockPos(2,1,2)); p.setPos(at.getX()+.5,at.getY(),at.getZ()+.5);
        p.getInventory().clearContent(); return p;
    }
    private static ItemEntity drop(GameTestHelper h,ServerPlayer p,ItemStack stack) {
        var e=new ItemEntity(h.getLevel(),p.getX(),p.getY(),p.getZ(),stack); e.setNoPickUpDelay(); h.getLevel().addFreshEntity(e); return e;
    }
    private static void partial(GameTestHelper h) {
        var p=player(h);
        try(var watch=PlayerPickupWatch.open(p)) {
            for(int i=0;i<36;i++) p.getInventory().setItem(i,new ItemStack(Items.COBBLESTONE,64));
            p.getInventory().setItem(35,new ItemStack(Items.COAL,62)); var e=drop(h,p,new ItemStack(Items.COAL,10));
            try { e.playerTouch(p);
                h.assertTrue(p.getInventory().countItem(Items.COAL)==64,"inventory must gain exactly two coal");
                h.assertTrue(e.getItem().getCount()==8,"eight coal must remain");
                h.assertTrue(watch.entries().size()==1&&watch.entries().getFirst().count()==2,"mixin must record actual gain");
            } finally { e.discard(); }
        }
        h.succeed();
    }
    private static void components(GameTestHelper h) {
        var p=player(h);
        try(var watch=PlayerPickupWatch.open(p)) {
            for(int i=0;i<36;i++) p.getInventory().setItem(i,new ItemStack(Items.COBBLESTONE,64));
            p.getInventory().setItem(35,new ItemStack(Items.COAL,63));
            var stack=new ItemStack(Items.COAL,5); stack.set(DataComponents.CUSTOM_NAME,Component.literal("named")); var e=drop(h,p,stack);
            try { e.playerTouch(p); h.assertTrue(watch.entries().isEmpty(),"different components cannot create pickup credit");
                h.assertTrue(e.getItem().getCount()==5,"blocked item remains");
            } finally { e.discard(); }
        }
        h.succeed();
    }
    private static void isolation(GameTestHelper h) {
        var a=player(h); var b=player(h);
        try(var ours=PlayerPickupWatch.open(a); var theirs=PlayerPickupWatch.open(b)) {
            var e=drop(h,b,new ItemStack(Items.RAW_IRON,3));
            try { e.playerTouch(b); h.assertTrue(ours.entries().isEmpty(),"another player must not create our receipt");
                h.assertTrue(theirs.entries().size()==1&&theirs.entries().getFirst().count()==3,"recipient receives actual credit");
            } finally { e.discard(); }
        }
        h.succeed();
    }
}
