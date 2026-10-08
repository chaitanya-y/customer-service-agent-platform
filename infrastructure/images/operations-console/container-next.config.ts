// Container-only overlay: preserve application configuration without editing it.
import applicationConfig from './next.config.base';

export default {
  ...applicationConfig,
  output: 'standalone',
  outputFileTracingRoot: '/app',
};
