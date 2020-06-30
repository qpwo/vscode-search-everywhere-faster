import * as vscode from "vscode";
import Config from "./config";
import WorkspaceData from "./interface/workspaceData";
import Utils from "./utils";
import ItemsFilter from "./interface/itemsFilter";

class DataService {
  private includePatterns!: string[];
  private excludePatterns!: string[];
  private filesAndSearchExcludePatterns!: string[];
  private itemsFilter!: ItemsFilter;
  private shouldUseFilesAndSearchExclude!: boolean;

  private onDidItemIndexedEventEmitter: vscode.EventEmitter<
    number
  > = new vscode.EventEmitter();
  readonly onDidItemIndexed: vscode.Event<number> = this
    .onDidItemIndexedEventEmitter.event;

  constructor(private utils: Utils, private config: Config) {
    this.fetchConfig();
  }

  reload() {
    this.fetchConfig();
  }

  async fetchData(uris?: vscode.Uri[]): Promise<WorkspaceData> {
    const workspaceData: WorkspaceData = this.utils.createWorkspaceData();
    const uriItems = await this.getUris(uris);

    await this.includeSymbols(workspaceData, uriItems);
    this.includeUris(workspaceData, uriItems);

    return workspaceData;
  }

  async isUriExistingInWorkspace(uri: vscode.Uri): Promise<boolean> {
    const uris = await this.fetchUris();
    return uris.some(
      (existingUri: vscode.Uri) => existingUri.fsPath === uri.fsPath
    );
  }

  private async fetchUris(): Promise<vscode.Uri[]> {
    const includePatterns = this.getIncludePatterns();
    const excludePatterns = this.getExcludePatterns();
    return await vscode.workspace.findFiles(includePatterns, excludePatterns);
  }

  private async getUris(uris?: vscode.Uri[]): Promise<vscode.Uri[]> {
    if (uris && uris.length) {
      return uris;
    } else {
      return await this.fetchUris();
    }
  }

  private getIncludePatterns(): string {
    return this.patternsAsString(this.includePatterns);
  }

  private getExcludePatterns(): string {
    let excludePatterns: string[] = [];

    if (this.shouldUseFilesAndSearchExclude) {
      excludePatterns = this.filesAndSearchExcludePatterns;
    } else {
      excludePatterns = this.excludePatterns;
    }

    return this.patternsAsString(excludePatterns);
  }

  private patternsAsString(patterns: string[]): string {
    if (patterns.length === 0) {
      return "";
    } else if (patterns.length === 1) {
      return patterns[0];
    } else {
      return `{${patterns.join(",")}}`;
    }
  }

  private async includeSymbols(
    workspaceData: WorkspaceData,
    uris: vscode.Uri[]
  ): Promise<void> {
    const maxCounter = 10;
    for (let i = 0; i < uris.length; i++) {
      const uri = uris[i];
      let counter = 0;
      let symbolsForUri: vscode.DocumentSymbol[] | undefined;

      do {
        symbolsForUri = await this.getSymbolsForUri(uri);
        if (counter) {
          await this.utils.sleep(120);
        }
        counter++;
      } while (symbolsForUri === undefined && counter < maxCounter);

      symbolsForUri &&
        symbolsForUri.length &&
        workspaceData.items.set(uri.fsPath, {
          uri,
          elements: symbolsForUri,
        });

      workspaceData.count += symbolsForUri ? symbolsForUri.length : 0;

      this.onDidItemIndexedEventEmitter.fire(uris.length);
    }
  }

  private includeUris(workspaceData: WorkspaceData, uris: vscode.Uri[]): void {
    const validUris = this.filterUris(uris);
    validUris.forEach((uri: vscode.Uri) => {
      const array = workspaceData.items.get(uri.fsPath);
      if (array) {
        const exists = this.ifUriExistsInArray(array.elements, uri);

        if (!exists) {
          array.elements.push(uri);
          workspaceData.count++;
        }
      } else {
        workspaceData.items.set(uri.fsPath, {
          uri,
          elements: [uri],
        });
        workspaceData.count++;
      }
    });
  }

  private ifUriExistsInArray(
    array: Array<vscode.Uri | vscode.DocumentSymbol>,
    uri: vscode.Uri
  ) {
    return array.some((uriInArray: vscode.Uri | vscode.DocumentSymbol) => {
      if (!uri.hasOwnProperty("range")) {
        uriInArray = uriInArray as vscode.Uri;
        return uriInArray.fsPath === uri.fsPath;
      }
      return false;
    });
  }

  private async getSymbolsForUri(
    uri: vscode.Uri
  ): Promise<vscode.DocumentSymbol[] | undefined> {
    const allSymbols = await this.loadAllSymbolsForUri(uri);
    const symbols = allSymbols
      ? this.reduceAndFlatSymbolsArrayForUri(allSymbols)
      : undefined;
    return symbols ? this.filterSymbols(symbols) : undefined;
  }

  private async loadAllSymbolsForUri(
    uri: vscode.Uri
  ): Promise<vscode.DocumentSymbol[] | undefined> {
    return await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri
    );
  }

  private reduceAndFlatSymbolsArrayForUri(
    symbols: vscode.DocumentSymbol[],
    parentName?: string
  ): vscode.DocumentSymbol[] {
    const flatSymbolsArray: vscode.DocumentSymbol[] = [];
    const splitter = this.utils.getSplitter();

    symbols.forEach((symbol: vscode.DocumentSymbol) => {
      if (parentName) {
        parentName = parentName.split(splitter)[0];
        symbol.name = `${parentName}${splitter}${symbol.name}`;
      }
      flatSymbolsArray.push(symbol);

      if (this.hasSymbolChildren(symbol)) {
        flatSymbolsArray.push(
          ...this.reduceAndFlatSymbolsArrayForUri(symbol.children, symbol.name)
        );
      }
      symbol.children = [];
    });

    return flatSymbolsArray;
  }

  private hasSymbolChildren(symbol: vscode.DocumentSymbol): boolean {
    return symbol.children && symbol.children.length ? true : false;
  }

  private filterUris(uris: vscode.Uri[]): vscode.Uri[] {
    return uris.filter((uri) => this.isUriValid(uri));
  }

  private filterSymbols(
    symbols: vscode.DocumentSymbol[]
  ): vscode.DocumentSymbol[] {
    return symbols.filter((symbol) => this.isSymbolValid(symbol));
  }

  private isUriValid(uri: vscode.Uri): boolean {
    return this.isItemValid(uri);
  }

  private isSymbolValid(symbol: vscode.DocumentSymbol): boolean {
    return this.isItemValid(symbol);
  }

  private isItemValid(item: vscode.Uri | vscode.DocumentSymbol): boolean {
    let kind: number;
    let name: string | undefined;
    const isUri = item.hasOwnProperty("path");

    if (isUri) {
      kind = 0;
      name = (item as vscode.Uri).path.split("/").pop();
    } else {
      const documentSymbol = item as vscode.DocumentSymbol;
      kind = documentSymbol.kind;
      name = documentSymbol.name;
    }

    return (
      this.isInAllowedKinds(this.itemsFilter, kind) &&
      this.isNotInIgnoredKinds(this.itemsFilter, kind) &&
      this.isNotInIgnoredNames(this.itemsFilter, name)
    );
  }

  private isInAllowedKinds(itemsFilter: ItemsFilter, kind: number): boolean {
    return (
      !(itemsFilter.allowedKinds && itemsFilter.allowedKinds.length) ||
      itemsFilter.allowedKinds.includes(kind)
    );
  }

  private isNotInIgnoredKinds(itemsFilter: ItemsFilter, kind: number): boolean {
    return (
      !(itemsFilter.ignoredKinds && itemsFilter.ignoredKinds.length) ||
      !itemsFilter.ignoredKinds.includes(kind)
    );
  }

  private isNotInIgnoredNames(
    itemsFilter: ItemsFilter,
    name: string | undefined
  ): boolean {
    return (
      !(itemsFilter.ignoredNames && itemsFilter.ignoredNames.length) ||
      !itemsFilter.ignoredNames.some(
        (ignoreEl) =>
          ignoreEl &&
          name &&
          name.toLowerCase().includes(ignoreEl.toLowerCase())
      )
    );
  }

  private fetchConfig() {
    this.includePatterns = this.config.getInclude();
    this.excludePatterns = this.config.getExclude();
    this.shouldUseFilesAndSearchExclude = this.config.shouldUseFilesAndSearchExclude();
    this.filesAndSearchExcludePatterns = this.config.getFilesAndSearchExclude();
    this.itemsFilter = this.config.getItemsFilter();
  }
}

export default DataService;
