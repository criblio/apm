// PostCSS config for the Capra design tokens plugin. Lets our CSS
// reference design tokens via the custom token() function — e.g.
// `color: token(color.brand);` — instead of raw CSS variables.
// Matches the my-app template's setup. The minimal token set keeps
// the bundle small; bump to allTokens (or a larger subset) if we
// start needing tokens outside the default.
import { capraTokenPostcssPlugin } from '@capra/dx-tokens-postcss-plugin';
import { allTokens } from '@capra/theme/dx/tokens-minimal';

export default {
  plugins: [capraTokenPostcssPlugin({ tokens: allTokens })],
};
