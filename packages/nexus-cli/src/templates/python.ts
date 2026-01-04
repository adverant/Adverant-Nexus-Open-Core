/**
 * Python plugin template generator
 */

import fs from 'fs-extra';
import path from 'path';

interface TemplateConfig {
  name: string;
  displayName: string;
  description: string;
  author: string;
  email: string;
  category: string;
  pricingModel: string;
}

export async function generatePythonTemplate(
  targetDir: string,
  config: TemplateConfig
): Promise<void> {
  // Create directory structure
  await fs.ensureDir(targetDir);
  await fs.ensureDir(path.join(targetDir, 'src'));
  await fs.ensureDir(path.join(targetDir, 'src', 'tools'));

  // pyproject.toml
  const pyprojectToml = `[project]
name = "${config.name}"
version = "1.0.0"
description = "${config.description}"
authors = [
    { name = "${config.author}", email = "${config.email}" }
]
requires-python = ">=3.10"
dependencies = [
    "mcp>=0.1.0",
    "pydantic>=2.0.0",
    "httpx>=0.25.0"
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0.0",
    "black>=23.0.0",
    "ruff>=0.1.0",
    "mypy>=1.0.0"
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.black]
line-length = 100

[tool.ruff]
line-length = 100

[tool.mypy]
strict = true
`;

  await fs.writeFile(path.join(targetDir, 'pyproject.toml'), pyprojectToml);

  // plugin.json
  const pluginJson = {
    name: config.name,
    displayName: config.displayName,
    description: config.description,
    version: '1.0.0',
    author: {
      name: config.author,
      email: config.email
    },
    category: config.category,
    tags: [config.category],
    pricingModel: config.pricingModel
  };

  await fs.writeJson(path.join(targetDir, 'plugin.json'), pluginJson, { spaces: 2 });

  // src/__init__.py
  await fs.writeFile(path.join(targetDir, 'src', '__init__.py'), '');

  // src/main.py
  const mainPy = `"""
${config.displayName}
${config.description}
"""

import asyncio
from mcp.server import Server
from mcp.types import Tool, TextContent

from .tools.greet import greet_tool
from .tools.example import example_tool

# Create MCP server
server = Server("${config.name}")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        greet_tool.definition,
        example_tool.definition,
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Execute a tool."""
    if name == "greet":
        return await greet_tool.execute(arguments)
    elif name == "example":
        return await example_tool.execute(arguments)
    else:
        raise ValueError(f"Unknown tool: {name}")


async def main():
    """Main entry point."""
    from mcp.server.stdio import stdio_server

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )


if __name__ == "__main__":
    asyncio.run(main())
`;

  await fs.writeFile(path.join(targetDir, 'src', 'main.py'), mainPy);

  // src/tools/__init__.py
  await fs.writeFile(path.join(targetDir, 'src', 'tools', '__init__.py'), '');

  // src/tools/greet.py
  const greetPy = `"""Greet tool implementation."""

from mcp.types import Tool, TextContent
from pydantic import BaseModel


class GreetInput(BaseModel):
    """Input for greet tool."""
    name: str


class GreetTool:
    """Greets a user by name."""

    @property
    def definition(self) -> Tool:
        """Tool definition."""
        return Tool(
            name="greet",
            description="Greets a user by name",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name to greet"
                    }
                },
                "required": ["name"]
            }
        )

    async def execute(self, arguments: dict) -> list[TextContent]:
        """Execute the tool."""
        input_data = GreetInput(**arguments)

        return [
            TextContent(
                type="text",
                text=f"👋 Hello, {input_data.name}! Welcome to ${config.displayName}!"
            )
        ]


greet_tool = GreetTool()
`;

  await fs.writeFile(path.join(targetDir, 'src', 'tools', 'greet.py'), greetPy);

  // src/tools/example.py
  const examplePy = `"""Example tool implementation."""

import os
from mcp.types import Tool, TextContent
from pydantic import BaseModel
import httpx


class ExampleInput(BaseModel):
    """Input for example tool."""
    data: str
    save: bool = False


class ExampleTool:
    """Example tool that demonstrates Nexus integration."""

    def __init__(self):
        self.nexus_api_url = os.getenv("NEXUS_API_URL", "http://nexus-api-gateway:8092")
        self.nexus_api_key = os.getenv("NEXUS_API_KEY", "")

    @property
    def definition(self) -> Tool:
        """Tool definition."""
        return Tool(
            name="example",
            description="Example tool that demonstrates Nexus integration",
            inputSchema={
                "type": "object",
                "properties": {
                    "data": {
                        "type": "string",
                        "description": "Data to process"
                    },
                    "save": {
                        "type": "boolean",
                        "description": "Save result to Nexus memory",
                        "default": False
                    }
                },
                "required": ["data"]
            }
        )

    async def execute(self, arguments: dict) -> list[TextContent]:
        """Execute the tool."""
        input_data = ExampleInput(**arguments)

        # Process the data
        result = f"Processed: {input_data.data.upper()}"

        # Optionally save to Nexus memory
        if input_data.save and self.nexus_api_key:
            try:
                async with httpx.AsyncClient() as client:
                    await client.post(
                        f"{self.nexus_api_url}/api/v1/nexus/store-memory",
                        headers={
                            "Authorization": f"Bearer {self.nexus_api_key}",
                            "Content-Type": "application/json"
                        },
                        json={
                            "content": result,
                            "tags": ["${config.name}", "example"],
                            "metadata": {
                                "plugin": "${config.name}"
                            }
                        }
                    )
            except Exception as e:
                print(f"Failed to store in Nexus: {e}")

        return [
            TextContent(
                type="text",
                text=result
            )
        ]


example_tool = ExampleTool()
`;

  await fs.writeFile(path.join(targetDir, 'src', 'tools', 'example.py'), examplePy);

  // .env.example
  const envExample = `# Nexus API Configuration
NEXUS_API_KEY=your_api_key_here
NEXUS_API_URL=http://nexus-api-gateway:8092

# Plugin Configuration
LOG_LEVEL=INFO
`;

  await fs.writeFile(path.join(targetDir, '.env.example'), envExample);

  // .gitignore
  const gitignore = `__pycache__/
*.py[cod]
*$py.class
*.so
.Python
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
wheels/
*.egg-info/
.installed.cfg
*.egg
.env
*.log
.DS_Store
.venv/
venv/
`;

  await fs.writeFile(path.join(targetDir, '.gitignore'), gitignore);

  // README.md
  const readme = `# ${config.displayName}

${config.description}

## Installation

\`\`\`bash
pip install -e .
\`\`\`

## Development

\`\`\`bash
# Install dev dependencies
pip install -e ".[dev]"

# Run the plugin
python -m src.main

# Run tests
pytest

# Format code
black src/
ruff check src/
\`\`\`

## Tools

### greet
Greets a user by name.

**Input:**
\`\`\`json
{
  "name": "Alice"
}
\`\`\`

**Output:**
\`\`\`
👋 Hello, Alice! Welcome to ${config.displayName}!
\`\`\`

### example
Example tool that demonstrates Nexus integration.

**Input:**
\`\`\`json
{
  "data": "test",
  "save": true
}
\`\`\`

## Deployment

\`\`\`bash
# Login to Nexus Nexus
nexus-cli login

# Register plugin
nexus-cli register

# Deploy to staging
nexus-cli deploy --environment staging

# Deploy to production
nexus-cli deploy --environment production
\`\`\`

## Configuration

Configure your plugin in \`plugin.json\`:

\`\`\`json
${JSON.stringify(pluginJson, null, 2)}
\`\`\`

## License

MIT © ${config.author}
`;

  await fs.writeFile(path.join(targetDir, 'README.md'), readme);
}
