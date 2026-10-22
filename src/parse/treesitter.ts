import { createRequire } from 'node:module';
import { Parser, Language, type Node as TSNode } from 'web-tree-sitter';
import type { DefinitionSymbol, SymbolKind } from '../model/types.js';
import { makeSymbol, type SymbolMapper } from './symbols.js';

const require = createRequire(import.meta.url);

/** Language id -> wasm file shipped by @vscode/tree-sitter-wasm. */
const WASM_FOR_LANGUAGE: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  c: 'tree-sitter-cpp.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  php: 'tree-sitter-php.wasm',
  csharp: 'tree-sitter-c-sharp.wasm',
};

const DEF_TYPES = new Map<string, SymbolKind>([
  ['function_declaration', 'function'],
  ['generator_function_declaration', 'function'],
  ['function_expression', 'function'],
  ['function_definition', 'function'],
  ['method_definition', 'method'],
  ['method_declaration', 'method'],
  ['class_declaration', 'class'],
  ['abstract_class_declaration', 'class'],
  ['class', 'class'],
  ['interface_declaration', 'interface'],
  ['type_alias_declaration', 'type'],
  ['enum_declaration', 'enum'],
  ['enum_specifier', 'enum'],
  ['internal_module', 'namespace'],
  ['namespace_declaration', 'namespace'],
  ['module_declaration', 'namespace'],
  ['public_field_definition', 'method'],
  ['lexical_declaration', 'variable'],
  ['variable_declaration', 'variable'],
  ['import_statement', 'import'],
  ['import_from_statement', 'import'],
  ['use_declaration', 'import'],
  ['impl_item', 'class'],
]);

let languagesPromise: Promise<Map<string, Language>> | null = null;

async function loadLanguages(): Promise<Map<string, Language>> {
  languagesPromise ??= (async () => {
    await Parser.init();
    const out = new Map<string, Language>();
    for (const [language, file] of Object.entries(WASM_FOR_LANGUAGE)) {
      const resolved = require.resolve(`@vscode/tree-sitter-wasm/wasm/${file}`);
      out.set(language, await Language.load(resolved));
    }
    return out;
  })();
  return languagesPromise;
}

function nodeName(node: TSNode): string | null {
  switch (node.type) {
    case 'lexical_declaration':
    case 'variable_declaration': {
      const declarator = node.namedChildren.find((c) => c?.type === 'variable_declarator');
      return declarator?.childForFieldName('name')?.text ?? null;
    }
    case 'import_statement':
    case 'import_from_statement':
    case 'use_declaration': {
      const source = node.childForFieldName('source') ?? node.childForFieldName('argument');
      return source ? source.text.replace(/^['"`]|['"`]$/g, '') : null;
    }
    default: {
      const nameNode = node.childForFieldName('name');
      return nameNode?.text ?? null;
    }
  }
}

/**
 * Primary symbol mapper backed by `web-tree-sitter` + the prebuilt grammars
 * from `@vscode/tree-sitter-wasm`. Purely offline: no network at runtime.
 */
export class TreeSitterSymbolMapper implements SymbolMapper {
  readonly name = 'tree-sitter';

  private constructor(private readonly languages: Map<string, Language>) {}

  static async create(): Promise<TreeSitterSymbolMapper> {
    return new TreeSitterSymbolMapper(await loadLanguages());
  }

  supports(language: string): boolean {
    return this.languages.has(language);
  }

  map(file: string, content: string, language: string): DefinitionSymbol[] {
    const lang = this.languages.get(language);
    if (!lang) return [];

    const parser = new Parser();
    let tree: ReturnType<Parser['parse']>;
    try {
      parser.setLanguage(lang);
      tree = parser.parse(content);
    } finally {
      // The tree keeps its own data; the parser can be released immediately.
      parser.delete();
    }
    if (!tree) return [];

    const symbols: DefinitionSymbol[] = [];
    const visit = (node: TSNode): void => {
      const kind = DEF_TYPES.get(node.type);
      if (kind) {
        const name = nodeName(node);
        if (name) {
          symbols.push(
            makeSymbol(file, name, kind, node.startPosition.row + 1, node.endPosition.row + 1),
          );
        }
      }
      for (const child of node.namedChildren) {
        if (child) visit(child);
      }
    };
    visit(tree.rootNode);
    tree.delete();

    return symbols;
  }
}

export interface MapperResolution {
  mapper: SymbolMapper | null;
  /** Non-fatal reason the tree-sitter mapper could not be created. */
  note?: string;
}

/**
 * Resolve the best available mapper. Never throws: on failure the caller falls
 * back to {@link HeuristicSymbolMapper} / proximity clustering.
 */
export async function resolveTreeSitterMapper(): Promise<MapperResolution> {
  try {
    return { mapper: await TreeSitterSymbolMapper.create() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      mapper: null,
      note: `tree-sitter grammars unavailable (${reason}); using heuristic symbol mapper`,
    };
  }
}
