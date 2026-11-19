// Lorelei by Lisa Wischofsky is CC0 1.0. The SDK runs locally; no HTTP API.
// Hair sets were selected from the installed 9.x style's actual variant previews.
const hair = Object.freeze({
  male: Object.freeze(['variant01', 'variant02', 'variant03', 'variant04', 'variant06', 'variant07', 'variant08', 'variant09', 'variant11', 'variant12', 'variant22', 'variant39', 'variant43', 'variant44', 'variant47']),
  female: Object.freeze(['variant15', 'variant16', 'variant19', 'variant21', 'variant23', 'variant24', 'variant29', 'variant30', 'variant32', 'variant35', 'variant40', 'variant41', 'variant45', 'variant48']),
  neutral: Object.freeze(['variant04', 'variant06', 'variant07', 'variant08', 'variant09', 'variant11', 'variant12', 'variant13', 'variant17', 'variant18', 'variant20', 'variant42']),
});
function normalizeGroup(value) {
  const group = String(value ?? '').trim().toLowerCase();
  return group === 'male' || group === 'female' ? group : 'neutral';
}
function avatarOptions(roll, group) {
  return {
    seed: roll, size: 400,
    hair: [...hair[normalizeGroup(group)]],
    backgroundColor: ['e8e2fc', 'fce2eb', 'dff3ed', 'dfebfb', 'fff0d8', 'eadff8'],
    beardProbability: 0, earringsProbability: 0, hairAccessoriesProbability: 0,
  };
}
let sdk;
async function generateAvatar(roll, group) {
  // collection/async loads only Lorelei rather than every style in the collection.
  if (!sdk) sdk = Promise.all([import('@dicebear/core'), import('@dicebear/collection/async').then(styles => styles.lorelei())])
    .catch(error => { sdk = undefined; throw error; });
  const [{ createAvatar }, lorelei] = await sdk;
  return Buffer.from(createAvatar(lorelei, avatarOptions(roll, group)).toString());
}
module.exports = { normalizeGroup, avatarOptions, generateAvatar };
