export const APPEND_COMPOSER_MESSAGES_COMMAND = "chatdev.cursor.appendComposerMessages";
export const PRUNE_COMPOSER_MESSAGES_COMMAND = "chatdev.cursor.pruneComposerMessages";
export const PRUNE_COMPOSER_MESSAGES_PATCH_MARKER = "chatdev.cursor.pruneComposerMessages.v2";
const WORKBENCH_CHECKSUM_KEY = "vs/workbench/workbench.desktop.main.js";

function commandRegistrationRange(source: string, command: string): { start: number; end: number } | undefined {
  const needle = `.registerCommand("${command}",`;
  const callIndex = source.indexOf(needle);
  if (callIndex < 0) return undefined;

  let start = callIndex;
  while (start > 0 && /[\w$]/.test(source[start - 1])) start -= 1;
  const openParenthesis = callIndex + ".registerCommand".length;
  let depth = 0;
  let quote = "";
  for (let index = openParenthesis; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        const end = source[index + 1] === ";" ? index + 2 : index + 1;
        return { start, end };
      }
    }
  }
  throw new Error(`Could not locate the end of Cursor command ${command}.`);
}

function composerCommandPatchContext(output: string): {
  insertionIndex: number;
  registry: string;
  service: string;
} {
  const handlePattern = /async run\(([\w$]+),([\w$]+)\)\{return \1\.get\(([\w$]+)\)\.getComposerHandleById\(\2\)\}/g;
  const handleMatches = [...output.matchAll(handlePattern)];
  const titleIndex = output.indexOf('original:"Get Composer Handle By Id"');
  const match = titleIndex >= 0
    ? handleMatches.sort((left, right) => Math.abs((left.index || 0) - titleIndex) - Math.abs((right.index || 0) - titleIndex))[0]
    : handleMatches[0];
  if (!match || match.index === undefined) throw new Error("This Cursor version does not expose its composer handle command.");

  const classPrefix = output.slice(Math.max(0, match.index - 2_000), match.index);
  const classMatches = [...classPrefix.matchAll(/var ([\w$]+)=class extends [\w$]+\{/g)];
  const commandClass = classMatches.at(-1)?.[1];
  if (!commandClass) throw new Error("Could not locate Cursor's composer handle command class.");

  const registrationNeedle = `(${commandClass});`;
  const registrationStart = output.indexOf(registrationNeedle, match.index + match[0].length);
  if (registrationStart < 0 || registrationStart - match.index > 3_000) {
    throw new Error("Could not locate Cursor's composer handle command registration.");
  }
  const insertionIndex = registrationStart + registrationNeedle.length;
  const prefix = output.slice(Math.max(0, insertionIndex - 50_000), insertionIndex);
  const registryMatches = [...prefix.matchAll(/([\w$]+)\.registerCommand\(/g)];
  const registry = registryMatches.at(-1)?.[1];
  if (!registry) throw new Error("Could not locate Cursor's internal command registry.");
  return { insertionIndex, registry, service: match[3] };
}

export function patchCursorWorkbenchSource(input: string): string {
  let output = input;
  if (!/isModelCompatibleWithClaudeCodeBackend\([^)]*\)\{return [^=]+==="chat\.dev"\|\|/.test(output)) {
    const pattern = /isModelCompatibleWithClaudeCodeBackend\(([\w$]+)\)\{return this\.isModelInOverrideList\(\1\)\}/;
    if (!pattern.test(output)) throw new Error("This Cursor version uses an unsupported Agent model router.");
    output = output.replace(pattern, (_match, argument: string) => (
      `isModelCompatibleWithClaudeCodeBackend(${argument}){return ${argument}==="chat.dev"||this.isModelInOverrideList(${argument})}`
    ));
  }
  if (!/getAgentBackendForFirstSubmit\([^)]*\)\{if\([^=]+\.modelName==="chat\.dev"\)/.test(output)) {
    const pattern = /getAgentBackendForFirstSubmit\(([\w$]+)\)\{const /;
    if (!pattern.test(output)) throw new Error("This Cursor version uses an unsupported first-turn router.");
    output = output.replace(pattern, (_match, argument: string) => (
      `getAgentBackendForFirstSubmit(${argument}){if(${argument}.modelName==="chat.dev")return{agentBackend:"claude-code",applyAgentBackendTypeRestrictions:false,restrictAgentModeSwitching:true};const `
    ));
  }
  if (!output.includes(APPEND_COMPOSER_MESSAGES_COMMAND)) {
    const { insertionIndex, registry, service } = composerCommandPatchContext(output);
    const appended = `${registry}.registerCommand("${APPEND_COMPOSER_MESSAGES_COMMAND}",async(chatdevAccessor,chatdevComposerId,chatdevBubbles)=>{const chatdevService=chatdevAccessor.get(${service}),chatdevHandle=await chatdevService.getComposerHandleById(chatdevComposerId);return chatdevHandle&&Array.isArray(chatdevBubbles)?(chatdevService.appendComposerBubbles(chatdevHandle,chatdevBubbles),!0):!1});`;
    output = `${output.slice(0, insertionIndex)}${appended}${output.slice(insertionIndex)}`;
  }
  const existingPruneCommand = commandRegistrationRange(output, PRUNE_COMPOSER_MESSAGES_COMMAND);
  const pruneCommandIsCurrent = existingPruneCommand
    ? output.slice(existingPruneCommand.start, existingPruneCommand.end).includes(PRUNE_COMPOSER_MESSAGES_PATCH_MARKER)
    : false;
  if (!pruneCommandIsCurrent) {
    const { insertionIndex, registry, service } = composerCommandPatchContext(output);
    const pruned = `${registry}.registerCommand("${PRUNE_COMPOSER_MESSAGES_COMMAND}",async(chatdevAccessor,chatdevComposerId)=>{const chatdevPatchVersion="${PRUNE_COMPOSER_MESSAGES_PATCH_MARKER}",chatdevService=chatdevAccessor.get(${service}),chatdevHandle=await chatdevService.getComposerHandleById(chatdevComposerId);if(!chatdevHandle)return 0;const chatdevData=chatdevService.getComposerData(chatdevHandle),chatdevHeaders=chatdevData?.fullConversationHeadersOnly||[],chatdevFirstId=chatdevHeaders[0]?.bubbleId,chatdevMessages=chatdevFirstId?await chatdevService.getConversationFromBubble(chatdevHandle,chatdevFirstId):[],chatdevSeen=new Set,chatdevDuplicates=[];for(const chatdevBubble of chatdevMessages){if(!chatdevBubble)continue;const chatdevRole=chatdevBubble.type===1||chatdevBubble.type==="1"?"user":chatdevBubble.type===2||chatdevBubble.type==="2"?"assistant":"",chatdevText=typeof chatdevBubble.text==="string"?chatdevBubble.text.trim():"",chatdevCreatedAt=typeof chatdevBubble.createdAt==="string"?chatdevBubble.createdAt:"",chatdevKey=chatdevRole&&chatdevText&&chatdevCreatedAt?chatdevRole+"\\0"+chatdevCreatedAt+"\\0"+chatdevText:"";if(!chatdevKey)continue;chatdevSeen.has(chatdevKey)?chatdevDuplicates.push(chatdevBubble.bubbleId):chatdevSeen.add(chatdevKey)}return chatdevPatchVersion&&chatdevDuplicates.length?(await chatdevService.deleteComposerBubbles(chatdevHandle,chatdevDuplicates),chatdevDuplicates.length):0});`;
    output = existingPruneCommand
      ? `${output.slice(0, existingPruneCommand.start)}${pruned}${output.slice(existingPruneCommand.end)}`
      : `${output.slice(0, insertionIndex)}${pruned}${output.slice(insertionIndex)}`;
  }
  const integrityStart = output.indexOf("_isPure(){");
  const integrityWait = output.indexOf("await this.lifecycleService.when(4);", integrityStart);
  if (integrityStart >= 0 && integrityWait >= 0) {
    const integrityHead = output.slice(integrityStart, integrityWait);
    if (integrityHead.includes("chatdevOnDiskChecksum")) {
      const checksums = integrityHead.match(/const ([\w$]+)=/)?.[1];
      if (!checksums) throw new Error("Could not update the existing Cursor installation checksum patch.");
      output = `${output.slice(0, integrityStart)}_isPure(){const ${checksums}=this.productService.checksums||{};${output.slice(integrityWait)}`;
    }
  }
  if (!output.includes("chatdevOnDiskChecksumV2")) {
    const productUriPattern = /_readOnDiskProductVersion\(\)\{try\{const [\w$]+=([\w$]+)\.joinPath\(\1\.file\(this\.environmentService\.appRoot\),"product\.json"\)/;
    const uriMatch = output.match(productUriPattern);
    if (!uriMatch) throw new Error("Could not locate Cursor's on-disk product reader.");
    const purityPattern = /_isPure\(\)\{const ([\w$]+)=this\.productService\.checksums\|\|\{\};await this\.lifecycleService\.when\(4\);/;
    if (!purityPattern.test(output)) throw new Error("Could not locate Cursor's installation checksum check.");
    output = output.replace(purityPattern, (_match, checksums: string) => (
      `_isPure(){const ${checksums}={...(this.productService.checksums||{})};await this.lifecycleService.when(4);try{const chatdevProductUri=${uriMatch[1]}.joinPath(${uriMatch[1]}.file(this.environmentService.appRoot),"product.json"),chatdevProduct=JSON.parse((await this.fileService.readFile(chatdevProductUri)).value.toString()),chatdevOnDiskChecksumV2=chatdevProduct?.checksums?.["${WORKBENCH_CHECKSUM_KEY}"];typeof chatdevOnDiskChecksumV2==="string"&&(${checksums}["${WORKBENCH_CHECKSUM_KEY}"]=chatdevOnDiskChecksumV2)}catch{}`
    ));
  }
  return output;
}
