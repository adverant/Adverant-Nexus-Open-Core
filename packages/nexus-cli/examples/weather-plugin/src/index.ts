/**
 * Weather Plugin
 *
 * Example plugin demonstrating the Nexus Plugin SDK
 */

import {
  PluginBuilder,
  arg,
  option,
  networkPermission,
  createPluginStorage,
} from '@adverant-nexus/cli-sdk';
import { currentWeatherCommand } from './commands/current.js';
import { forecastCommand } from './commands/forecast.js';

// Create plugin storage
const storage = createPluginStorage('weather-plugin');

export default PluginBuilder.create('weather-plugin')
  .version('1.0.0')
  .description('Example weather plugin for Nexus CLI')
  .author('Nexus Team')

  // Add current weather command
  .command('current', {
    description: 'Get current weather for a city',
    args: [
      arg('city', {
        description: 'City name',
        required: true,
        type: 'string',
      }),
    ],
    handler: currentWeatherCommand,
    examples: [
      'nexus plugin weather-plugin current "San Francisco"',
      'nexus plugin weather-plugin current "New York"',
    ],
  })

  // Add forecast command
  .command('forecast', {
    description: 'Get weather forecast',
    args: [
      arg('city', {
        description: 'City name',
        required: true,
        type: 'string',
      }),
    ],
    options: [
      option('days', {
        short: 'd',
        description: 'Number of days to forecast',
        type: 'number',
        default: 5,
      }),
    ],
    handler: forecastCommand,
    examples: [
      'nexus plugin weather-plugin forecast "London"',
      'nexus plugin weather-plugin forecast "Tokyo" --days 7',
    ],
  })

  // Add network permission
  .permission(networkPermission('http', 'read'))

  // Lifecycle hooks
  .onLoad(async () => {
    console.log('🌤️  Weather plugin loaded');
    await storage.initialize();

    // Cache API key if needed
    const apiKey = storage.get('apiKey');
    if (!apiKey) {
      console.log('💡 Set API key: storage.set("apiKey", "your-key")');
    }
  })

  .onUnload(async () => {
    console.log('👋 Weather plugin unloaded');
  })

  .onEnable(async () => {
    console.log('✅ Weather plugin enabled');
  })

  .onDisable(async () => {
    console.log('⏸️  Weather plugin disabled');
  })

  .build();
