/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.minecraft;

import dev.mcplayeragent.harness.PlayerDecision;
import com.google.gson.*;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.*;

/** Calls the same client interactions and packets used by a human player. */
final class PlayerActions {
    private PlayerActions() {}

    static String once(PlayerDecision d) {
        Minecraft mc = Minecraft.getInstance();
        var p = mc.player;
        return switch (d.action()) {
            case INVENTORY -> { mc.setScreen(new InventoryScreen(p)); yield "Inventory opened"; }
            case CLOSE -> { p.closeContainer(); mc.setScreen(null); yield "Screen closed"; }
            case DROP -> "Drop packet: " + p.drop(d.all());
            case SWAP -> {
                p.connection.send(new ServerboundPlayerActionPacket(ServerboundPlayerActionPacket.Action.SWAP_ITEM_WITH_OFFHAND,
                        BlockPos.ZERO, Direction.DOWN)); yield "Offhand swap requested";
            }
            case CLICK -> {
                menu(d);
                if (d.index() != -999 && (d.index() < 0 || d.index() >= p.containerMenu.slots.size()))
                    throw new IllegalArgumentException("Slot is not in the current menu");
                mc.gameMode.handleInventoryMouseClick(d.menu(), d.index(), d.button(), ClickType.valueOf(d.click()), p);
                yield "Native slot click sent; inspect menu for result";
            }
            case CRAFT -> {
                menu(d);
                var recipe = mc.level.getRecipeManager().byKey(ResourceLocation.parse(d.text()))
                        .orElseThrow(() -> new IllegalArgumentException("Recipe id not found"));
                mc.gameMode.handlePlaceRecipe(d.menu(), recipe, d.all());
                yield "Recipe placement requested; inspect grid and click output slot to collect";
            }
            case RECIPES -> recipes(d.text());
            case GUI_CLICK -> {
                screen(d);
                var children = mc.screen.children();
                if (d.index() < 0 || d.index() >= children.size() || !(children.get(d.index()) instanceof AbstractWidget widget))
                    throw new IllegalArgumentException("Widget index not found");
                mc.screen.mouseClicked(widget.getX() + widget.getWidth() / 2.0,
                        widget.getY() + widget.getHeight() / 2.0, d.button());
                if (mc.screen != null) mc.screen.mouseReleased(widget.getX() + widget.getWidth() / 2.0,
                        widget.getY() + widget.getHeight() / 2.0, d.button());
                yield "Native widget click delivered";
            }
            case TEXT -> {
                screen(d);
                for (char c : d.text().toCharArray()) mc.screen.charTyped(c, 0);
                yield "Text delivered to focused game widget";
            }
            case KEY -> {
                screen(d); var screen = mc.screen;
                screen.keyPressed(d.index(), 0, d.button()); screen.keyReleased(d.index(), 0, d.button());
                yield "Native GUI key delivered";
            }
            case COMMAND -> {
                String command = d.text().strip();
                if (command.startsWith("/")) command = command.substring(1);
                p.connection.sendCommand(command);
                yield "Game command sent with current player permissions; success not assumed";
            }
            case CHAT -> {
                if (d.text().length() > 256) throw new IllegalArgumentException("Minecraft chat packets allow at most 256 characters");
                p.connection.sendChat(d.text()); yield "Game chat sent";
            }
            default -> "Input window executed";
        };
    }

    static String attack() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.hitResult instanceof EntityHitResult hit) {
            if (mc.player.getAttackStrengthScale(0) >= 1) {
                mc.gameMode.attack(mc.player, hit.getEntity()); mc.player.swing(InteractionHand.MAIN_HAND);
                return "Entity attack sent";
            }
            return "Waiting for attack cooldown";
        }
        if (mc.hitResult instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK) {
            mc.gameMode.continueDestroyBlock(hit.getBlockPos(), hit.getDirection());
            mc.player.swing(InteractionHand.MAIN_HAND); return "Native mining stroke";
        }
        return "No attack target";
    }

    static String use(PlayerDecision d) {
        Minecraft mc = Minecraft.getInstance();
        InteractionHand hand = d.offhand() ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
        InteractionResult result = InteractionResult.PASS;
        if (mc.hitResult instanceof EntityHitResult hit) {
            result = mc.gameMode.interactAt(mc.player, hit.getEntity(), hit, hand);
            if (!result.consumesAction()) result = mc.gameMode.interact(mc.player, hit.getEntity(), hand);
        } else if (mc.hitResult instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK) {
            result = mc.gameMode.useItemOn(mc.player, hand, hit);
        }
        if (!result.consumesAction()) result = mc.gameMode.useItem(mc.player, hand);
        if (result.shouldSwing()) mc.player.swing(hand);
        return "Use result=" + result + "; inspect world/menu/inventory to confirm";
    }

    private static void menu(PlayerDecision d) {
        if (Minecraft.getInstance().player.containerMenu.containerId != d.menu())
            throw new IllegalArgumentException("Stale menu id: refresh observation");
    }
    private static void screen(PlayerDecision d) {
        var screen = Minecraft.getInstance().screen;
        if (screen == null || !screen.getClass().getName().equals(d.screen()))
            throw new IllegalArgumentException("Stale screen: refresh observation");
    }
    private static String recipes(String query) {
        JsonArray recipes = new JsonArray();
        Minecraft.getInstance().level.getRecipeManager().getRecipes().stream()
                .filter(r -> r.id().toString().contains(query)).limit(16).forEach(r -> {
                    JsonObject recipe = new JsonObject(); recipe.addProperty("id", r.id().toString());
                    if(r.value() instanceof net.minecraft.world.item.crafting.CraftingRecipe crafting) {
                        recipe.add("output",stack(crafting.getResultItem(Minecraft.getInstance().level.registryAccess())));
                        recipe.addProperty("grid",crafting.canCraftInDimensions(2,2)?2:3);
                    }
                    JsonArray ingredients = new JsonArray();
                    r.value().getIngredients().forEach(i -> {
                        JsonArray choices = new JsonArray();
                        for (ItemStack stack : i.getItems()) choices.add(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
                        ingredients.add(choices);
                    });
                    recipe.add("ingredients", ingredients); recipes.add(recipe);
                });
        return recipes.toString();
    }
    static JsonObject stack(ItemStack stack) {
        JsonObject out = new JsonObject(); out.addProperty("item", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        out.addProperty("count", stack.getCount()); return out;
    }
    /** Local comparison only: editable values are hashed and never sent as model observations. */
    static String guiSignature() {
        var screen = Minecraft.getInstance().screen;
        if (screen == null) return "none";
        StringBuilder signature = new StringBuilder(screen.getClass().getName());
        for (var child : screen.children()) if (child instanceof AbstractWidget widget) {
            signature.append('|').append(widget.getMessage().getString()).append(':').append(widget.active).append(':').append(widget.isFocused());
            if (widget instanceof net.minecraft.client.gui.components.EditBox box) signature.append(':').append(box.getValue().hashCode());
        }
        return Integer.toHexString(signature.toString().hashCode());
    }
    static void observe(JsonObject out) {
        Minecraft mc = Minecraft.getInstance();
        JsonObject menu = new JsonObject(); menu.addProperty("id", mc.player.containerMenu.containerId);
        menu.add("carried", stack(mc.player.containerMenu.getCarried()));
        JsonArray slots = new JsonArray();
        for (int i = 0; i < mc.player.containerMenu.slots.size(); i++) {
            var slot = mc.player.containerMenu.slots.get(i);
            JsonObject entry = stack(slot.getItem()); entry.addProperty("index", i); slots.add(entry);
            entry.addProperty("role",slot instanceof net.minecraft.world.inventory.ResultSlot?"craft_output":
                    slot.container instanceof net.minecraft.world.inventory.CraftingContainer?"craft_grid":
                    slot.container==mc.player.getInventory()?"player_inventory":"container");
        }
        menu.add("slots", slots); out.add("menu", menu);
        out.addProperty("using_item", mc.player.isUsingItem());
        out.addProperty("sprinting", mc.player.isSprinting()); out.addProperty("flying", mc.player.getAbilities().flying);
        if (mc.screen != null) {
            JsonObject screen = new JsonObject(); screen.addProperty("class", mc.screen.getClass().getName());
            screen.addProperty("title", mc.screen.getTitle().getString());
            JsonArray widgets = new JsonArray();
            for (int i = 0; i < mc.screen.children().size(); i++) {
                if (mc.screen.children().get(i) instanceof AbstractWidget widget) {
                    JsonObject w = new JsonObject(); w.addProperty("index", i); w.addProperty("label", widget.getMessage().getString());
                    w.addProperty("active", widget.active); w.addProperty("visible", widget.visible);
                    w.addProperty("focused", widget.isFocused());
                    widgets.add(w);
                }
            }
            screen.add("widgets", widgets); out.add("screen", screen);
        }
    }
}
