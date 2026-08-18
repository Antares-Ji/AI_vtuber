const { LUOTIANYI_PERSONA } = require("./luotianyi");
const { GENERIC_PERSONA } = require("./generic");

const CHARACTER_PACKS = Object.freeze({
  luotianyi: LUOTIANYI_PERSONA,
  generic: GENERIC_PERSONA
});

function loadCharacterPack(id = process.env.CHARACTER_PACK || "luotianyi") {
  return CHARACTER_PACKS[String(id).toLowerCase()] || GENERIC_PERSONA;
}

module.exports = { CHARACTER_PACKS, loadCharacterPack };
