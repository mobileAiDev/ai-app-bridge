'use strict';

// Global installation is the documented automatic client-setup entry point.
// npm dependencies and ephemeral npx invocations never modify user clients.
if (process.env.npm_config_global === 'true' && process.env.AI_APP_BRIDGE_SKIP_SETUP !== '1') {
  require('./cli').main([]);
}
