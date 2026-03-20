// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  // Update with your actual domain
  site: 'https://claudeblog.bitflop.xyz',

  output: 'static',
  adapter: cloudflare(),
});