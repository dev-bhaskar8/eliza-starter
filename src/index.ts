import { SqliteDatabaseAdapter } from "@ai16z/adapter-sqlite";
import { DirectClientInterface } from "@ai16z/client-direct";
import { TwitterClientInterface } from "@ai16z/client-twitter";
import {
  DbCacheAdapter,
  defaultCharacter,
  FsCacheAdapter,
  ICacheManager,
  IDatabaseCacheAdapter,
  stringToUuid,
  AgentRuntime,
  CacheManager,
  Character,
  IAgentRuntime,
  ModelProviderName,
  elizaLogger,
  settings,
  IDatabaseAdapter,
  validateCharacterConfig,
} from "@ai16z/eliza";
import { bootstrapPlugin } from "@ai16z/plugin-bootstrap";
import Database from "better-sqlite3";
import fs from "fs";
import readline from "readline";
import yargs from "yargs";
import path from "path";
import { fileURLToPath } from "url";
import { character } from "./character.ts";
import type { DirectClient } from "@ai16z/client-direct";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let rl: readline.Interface | null = null;
let isShuttingDown = false;
let db: Database.Database | null = null;
let dbAdapter: SqliteDatabaseAdapter | null = null;
let cache: ICacheManager | null = null;
let directClient: DirectClient | null = null;

// Memory management
const MEMORY_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MEMORY_THRESHOLD = 400 * 1024 * 1024; // 400MB

function checkMemoryUsage() {
  const used = process.memoryUsage();
  if (used.heapUsed > MEMORY_THRESHOLD) {
    elizaLogger.warn(`High memory usage detected: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
    global.gc?.();
    elizaLogger.log("Garbage collection triggered");
  }
}

setInterval(checkMemoryUsage, MEMORY_CHECK_INTERVAL);

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

function cleanup() {
  isShuttingDown = true;
  if (rl) {
    rl.close();
    rl = null;
  }
  if (db) {
    db.close();
    db = null;
  }
  if (dbAdapter) {
    dbAdapter = null;
  }
  if (cache) {
    cache = null;
  }
  if (directClient) {
    directClient = null;
  }
  global.gc?.();
}

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
  const waitTime =
    Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

export function parseArguments(): {
  character?: string;
  characters?: string;
} {
  try {
    return yargs(process.argv.slice(2))
      .option("character", {
        type: "string",
        description: "Path to the character JSON file",
      })
      .option("characters", {
        type: "string",
        description: "Comma separated list of paths to character JSON files",
      })
      .parseSync();
  } catch (error) {
    console.error("Error parsing arguments:", error);
    return {};
  }
}

export async function loadCharacters(
  charactersArg: string
): Promise<Character[]> {
  let characterPaths = charactersArg?.split(",").map((filePath) => {
    if (path.basename(filePath) === filePath) {
      filePath = "../characters/" + filePath;
    }
    return path.resolve(process.cwd(), filePath.trim());
  });

  const loadedCharacters = [];

  if (characterPaths?.length > 0) {
    for (const path of characterPaths) {
      try {
        const character = JSON.parse(fs.readFileSync(path, "utf8"));

        validateCharacterConfig(character);

        loadedCharacters.push(character);
      } catch (e) {
        console.error(`Error loading character from ${path}: ${e}`);
        // don't continue to load if a specified file is not found
        process.exit(1);
      }
    }
  }

  if (loadedCharacters.length === 0) {
    console.log("No characters found, using default character");
    loadedCharacters.push(defaultCharacter);
  }

  return loadedCharacters;
}

export function getTokenForProvider(
  provider: ModelProviderName,
  character: Character
) {
  switch (provider) {
    case ModelProviderName.OPENAI:
      return (
        character.settings?.secrets?.OPENAI_API_KEY || settings.OPENAI_API_KEY
      );
    case ModelProviderName.LLAMACLOUD:
      return (
        character.settings?.secrets?.LLAMACLOUD_API_KEY ||
        settings.LLAMACLOUD_API_KEY ||
        character.settings?.secrets?.TOGETHER_API_KEY ||
        settings.TOGETHER_API_KEY ||
        character.settings?.secrets?.XAI_API_KEY ||
        settings.XAI_API_KEY ||
        character.settings?.secrets?.OPENAI_API_KEY ||
        settings.OPENAI_API_KEY
      );
    case ModelProviderName.ANTHROPIC:
      return (
        character.settings?.secrets?.ANTHROPIC_API_KEY ||
        character.settings?.secrets?.CLAUDE_API_KEY ||
        settings.ANTHROPIC_API_KEY ||
        settings.CLAUDE_API_KEY
      );
    case ModelProviderName.REDPILL:
      return (
        character.settings?.secrets?.REDPILL_API_KEY || settings.REDPILL_API_KEY
      );
    case ModelProviderName.OPENROUTER:
      return (
        character.settings?.secrets?.OPENROUTER || settings.OPENROUTER_API_KEY
      );
    case ModelProviderName.GROK:
      return character.settings?.secrets?.GROK_API_KEY || settings.GROK_API_KEY;
    case ModelProviderName.HEURIST:
      return (
        character.settings?.secrets?.HEURIST_API_KEY || settings.HEURIST_API_KEY
      );
    case ModelProviderName.GROQ:
      return character.settings?.secrets?.GROQ_API_KEY || settings.GROQ_API_KEY;
  }
}

function initializeDatabase(dataDir: string): SqliteDatabaseAdapter {
  if (dbAdapter) {
    return dbAdapter;
  }
  db = new Database(path.join(dataDir, "cache.db"), {
    verbose: console.log,
  });
  dbAdapter = new SqliteDatabaseAdapter(db);
  return dbAdapter;
}

export async function initializeClients(
  character: Character,
  runtime: IAgentRuntime
) {
  const clients = [];
  const clientTypes = character.clients?.map((str) => str.toLowerCase()) || [];

  if (clientTypes.includes("twitter")) {
    const twitterClients = await TwitterClientInterface.start(runtime);
    clients.push(twitterClients);
  }

  if (character.plugins?.length > 0) {
    for (const plugin of character.plugins) {
      if (plugin.clients) {
        for (const client of plugin.clients) {
          clients.push(await client.start(runtime));
        }
      }
    }
  }

  return clients;
}

export function createAgent(
  character: Character,
  db: IDatabaseAdapter,
  cache: ICacheManager,
  token: string
) {
  elizaLogger.success(
    elizaLogger.successesTitle,
    "Creating runtime for character",
    character.name
  );
  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [bootstrapPlugin].filter(Boolean),
    providers: [],
    actions: [],
    services: [],
    managers: [],
    cacheManager: cache,
  });
}

function intializeFsCache(baseDir: string, character: Character) {
  const cacheDir = path.resolve(baseDir, character.id, "cache");

  const cache = new CacheManager(new FsCacheAdapter(cacheDir));
  return cache;
}

function intializeDbCache(character: Character, db: SqliteDatabaseAdapter): ICacheManager {
  if (cache) {
    return cache;
  }
  cache = new CacheManager(new DbCacheAdapter(db, character.id));
  return cache;
}

async function startAgent(character: Character, client: DirectClient) {
  try {
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;

    const token = getTokenForProvider(character.modelProvider, character);
    const dataDir = path.join(__dirname, "../data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = initializeDatabase(dataDir);
    await db.init();

    const cache = intializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token);

    await runtime.initialize();

    try {
      await initializeClients(character, runtime);
    } catch (error) {
      elizaLogger.warn("Failed to initialize some clients, continuing with direct chat only:", error);
    }

    client.registerAgent(runtime);
  } catch (error) {
    elizaLogger.error(
      `Error starting agent for character ${character.name}:`,
      error
    );
    throw error;
  }
}

const startAgents = async () => {
  try {
    const client = await DirectClientInterface.start() as DirectClient;
    directClient = client;
    const args = parseArguments();

    let charactersArg = args.characters || args.character;

    let characters = [character];
    console.log("charactersArg", charactersArg);
    if (charactersArg) {
      characters = await loadCharacters(charactersArg);
    }
    console.log("characters", characters);

    // Limit concurrent character loading
    for (const character of characters) {
      await startAgent(character, client);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Add delay between character loads
    }

    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    function chat() {
      if (isShuttingDown) return;
      
      const agentId = characters[0].name ?? "Agent";
      rl?.question("You: ", async (input) => {
        try {
          if (input.toLowerCase() === "exit") {
            cleanup();
            process.exit(0);
            return;
          }

          await handleUserInput(input, agentId);
          global.gc?.(); // Trigger GC after processing input
          if (!isShuttingDown) {
            chat();
          }
        } catch (error) {
          console.error("Error handling user input:", error);
          if (!isShuttingDown) {
            chat();
          }
        }
      });
    }

    elizaLogger.log("Chat started. Type 'exit' to quit.");
    chat();

  } catch (error) {
    elizaLogger.error("Error starting agents:", error);
    cleanup();
    process.exit(1);
  }
};

startAgents().catch((error) => {
  elizaLogger.error("Unhandled error in startAgents:", error);
  cleanup();
  process.exit(1);
});

async function handleUserInput(input: string, agentId: string) {
  try {
    const serverPort = parseInt(settings.SERVER_PORT || "3001");

    const response = await fetch(
      `http://localhost:${serverPort}/${agentId}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: input,
          userId: "user",
          userName: "User",
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    data.forEach((message: any) => console.log(`${agentId}: ${message.text}`));
  } catch (error) {
    console.error("Error fetching response:", error);
    throw error;
  }
}
