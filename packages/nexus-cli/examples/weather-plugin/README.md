# Weather Plugin

Example weather plugin for Nexus CLI demonstrating the Plugin SDK.

## Features

- Get current weather for any city
- Get weather forecast for multiple days
- Storage API for caching API keys
- Full TypeScript support

## Installation

```bash
# Install dependencies
npm install

# Build plugin
npm run build
```

## Usage

```bash
# Install plugin to Nexus CLI
nexus plugin install ./examples/weather-plugin

# Enable plugin
nexus plugin enable weather-plugin

# Get current weather
nexus plugin weather-plugin current "San Francisco"

# Get 7-day forecast
nexus plugin weather-plugin forecast "London" --days 7
```

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Clean
npm run clean
```

## Commands

### current

Get current weather for a city.

```bash
nexus plugin weather-plugin current <city>
```

**Arguments:**
- `city` (required): City name

**Example:**
```bash
nexus plugin weather-plugin current "New York"
```

### forecast

Get weather forecast for a city.

```bash
nexus plugin weather-plugin forecast <city> [--days <number>]
```

**Arguments:**
- `city` (required): City name

**Options:**
- `-d, --days <number>`: Number of days to forecast (default: 5)

**Example:**
```bash
nexus plugin weather-plugin forecast "Tokyo" --days 7
```

## Architecture

This plugin demonstrates:

1. **Plugin Builder API**: Fluent API for creating plugins
2. **Command Handlers**: Async functions that process commands
3. **Plugin Context**: Access to logger, storage, and services
4. **Lifecycle Hooks**: onLoad, onUnload, onEnable, onDisable
5. **Permissions**: Request network access
6. **Storage API**: Persist data between sessions

## License

MIT
