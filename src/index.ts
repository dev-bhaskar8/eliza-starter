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
const MEMORY_CHECK_INTERVAL = 1 * 60 * 1000; // 1 minute
const MEMORY_THRESHOLD = 350 * 1024 * 1024; // 350MB
const CRITICAL_MEMORY_THRESHOLD = 375 * 1024 * 1024; // 375MB

function checkMemoryUsage() {
  const used = process.memoryUsage();
  const heapUsed = Math.round(used.heapUsed / 1024 / 1024);
  
  if (used.heapUsed > CRITICAL_MEMORY_THRESHOLD) {
    elizaLogger.error(`Critical memory usage detected: ${heapUsed}MB. Initiating emergency cleanup...`);
    cleanup();
    process.exit(1);
  } else if (used.heapUsed > MEMORY_THRESHOLD) {
    elizaLogger.warn(`High memory usage detected: ${heapUsed}MB`);
    global.gc?.();
    elizaLogger.log("Garbage collection triggered");
  }
}

// More frequent memory checks
setInterval(checkMemoryUsage, MEMORY_CHECK_INTERVAL);

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  elizaLogger.error('Uncaught Exception:', error);
  cleanup();
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  elizaLogger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  cleanup();
  process.exit(1);
});

function cleanup() {
  isShuttingDown = true;
  
  try {
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
    
    // Force garbage collection
    global.gc?.();
    
    // Clear module cache to free memory
    Object.keys(require.cache).forEach((key) => {
      delete require.cache[key];
    });
    
    // Clear any intervals
    const intervals = (global as any)[Symbol.for('nodejs.timer.intervals')];
    if (intervals) {
      intervals.forEach((interval: any) => {
        clearInterval(interval);
      });
    }
    
    // Clear any timeouts
    const timeouts = (global as any)[Symbol.for('nodejs.timer.timeouts')];
    if (timeouts) {
      timeouts.forEach((timeout: any) => {
        clearTimeout(timeout);
      });
    }
  } catch (error) {
    elizaLogger.error('Error during cleanup:', error);
  }
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
    
    // Force garbage collection after agent initialization
    global.gc?.();
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
    if (charactersArg) {
      characters = await loadCharacters(charactersArg);
    }

    // Limit concurrent character loading and add memory checks
    for (const character of characters) {
      checkMemoryUsage(); // Check memory before loading each character
      await startAgent(character, client);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Increased delay between character loads
      global.gc?.(); // Force GC after each character load
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

          checkMemoryUsage(); // Check memory before processing input
          await handleUserInput(input, agentId);
          global.gc?.(); // Force GC after processing input
          
          if (!isShuttingDown) {
            // Add small delay before next prompt to allow GC to work
            setTimeout(chat, 100);
          }
        } catch (error) {
          console.error("Error handling user input:", error);
          if (!isShuttingDown) {
            setTimeout(chat, 100);
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
    
    // Clear data after processing
    response.body?.cancel();
  } catch (error) {
    console.error("Error fetching response:", error);
    throw error;
  }
}
