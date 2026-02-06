import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs, { Database } from 'sql.js';

interface JoplinToObsidianSettings {
  joplinDbPath: string;
  joplinResourceDir: string;
  targetFolderName: string;
  outputFolder: string;
  attachmentsFolderName: string;
}

const DEFAULT_SETTINGS: JoplinToObsidianSettings = {
  joplinDbPath: '~/.config/joplin-desktop/database.sqlite',
  joplinResourceDir: '~/.config/joplin-desktop/resources',
  targetFolderName: 'joplin',
  outputFolder: 'joplin',
  attachmentsFolderName: 'assets'
};

interface FolderHierarchy {
  [folderId: string]: string;
}

interface ResourceLookup {
  [resourceId: string]: string;
}

export default class JoplinToObsidianPlugin extends Plugin {
  settings: JoplinToObsidianSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'import-joplin-notes',
      name: '从 Joplin 导入笔记',
      callback: () => this.importNotes()
    });

    this.addSettingTab(new JoplinToObsidianSettingTab(this.app, this));
  }

  async loadSettings() {
    const saved = await this.loadData() || {};
    this.settings = {
      joplinDbPath: saved.joplinDbPath || DEFAULT_SETTINGS.joplinDbPath,
      joplinResourceDir: saved.joplinResourceDir || DEFAULT_SETTINGS.joplinResourceDir,
      targetFolderName: saved.targetFolderName || DEFAULT_SETTINGS.targetFolderName,
      outputFolder: saved.outputFolder || DEFAULT_SETTINGS.outputFolder,
      attachmentsFolderName: saved.attachmentsFolderName || DEFAULT_SETTINGS.attachmentsFolderName,
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 展开路径中的 ~ 为用户主目录 */
  private expandPath(p: string): string {
    if (p.startsWith('~/')) {
      return path.join(os.homedir(), p.slice(2));
    }
    if (p === '~') {
      return os.homedir();
    }
    return p;
  }

  /** 清理文件名中的非法字符 */
  private sanitizeFilename(name: string): string {
    return name.replace(/[\\/:"*?<>|]+/g, '_');
  }

  /** 构建资源 ID -> 文件名映射 */
  private buildResourceLookup(): ResourceLookup {
    const lookup: ResourceLookup = {};
    const resourceDir = this.expandPath(this.settings.joplinResourceDir);
    
    if (!fs.existsSync(resourceDir)) {
      console.warn(`资源目录不存在: ${resourceDir}`);
      return lookup;
    }

    const files = fs.readdirSync(resourceDir);
    for (const fname of files) {
      // 严格匹配带后缀的资源文件 (32位hex ID + 扩展名)
      if (/^[a-f0-9]{32}\.\w+$/.test(fname)) {
        const rid = fname.split('.')[0];
        lookup[rid] = fname;
      }
    }
    return lookup;
  }

  /** 获取文件夹层级结构 */
  private getFolderHierarchy(db: Database, targetFolderName: string): { hierarchy: FolderHierarchy; rootFolderId: string } {
    // 获取目标笔记本的 ID
    const rootResult = db.exec(
      `SELECT id FROM folders WHERE title = '${targetFolderName.replace(/'/g, "''")}' AND parent_id = ''`
    );
    
    if (!rootResult.length || !rootResult[0].values.length) {
      throw new Error(`找不到名为 '${targetFolderName}' 的 Joplin 笔记本`);
    }

    const rootFolderId = rootResult[0].values[0][0] as string;
    const hierarchy: FolderHierarchy = {};
    hierarchy[rootFolderId] = '';

    // 递归构建文件夹层级
    const buildHierarchy = (parentId: string, basePath: string) => {
      const subfolders = db.exec(
        `SELECT id, title FROM folders WHERE parent_id = '${parentId}'`
      );
      
      if (!subfolders.length) return;

      for (const row of subfolders[0].values) {
        const folderId = row[0] as string;
        const folderTitle = row[1] as string;
        const folderPath = basePath 
          ? path.join(basePath, this.sanitizeFilename(folderTitle))
          : this.sanitizeFilename(folderTitle);
        hierarchy[folderId] = folderPath;
        buildHierarchy(folderId, folderPath);
      }
    };

    buildHierarchy(rootFolderId, '');
    return { hierarchy, rootFolderId };
  }

  /** 处理笔记内容中的资源链接，图片按 notename-001.ext 格式重命名 */
  private processResources(
    body: string,
    resourceLookup: ResourceLookup,
    vaultPath: string,
    noteBaseName: string
  ): string {
    const attachmentsFolderName = this.settings.attachmentsFolderName;
    const resourceDir = this.expandPath(this.settings.joplinResourceDir);

    // 统一的 assets 目录（放在 vault 根目录下）
    const assetsDir = path.join(vaultPath, attachmentsFolderName);

    // 图片扩展名列表
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp']);
    
    // 1. 先扫描所有资源引用，按出现顺序分配固定序号
    const resourceMatches = [...body.matchAll(/!\[\]\(:\/([a-f0-9]{32})\)/g)];
    const ridToNewFilename = new Map<string, string>();
    let imageCounter = 0;
    
    for (const match of resourceMatches) {
      const rid = match[1];
      if (ridToNewFilename.has(rid)) continue; // 同一资源只处理一次
      
      if (!resourceLookup[rid]) {
        console.warn(`未找到资源: ${rid}`);
        continue;
      }
      
      const resFilename = resourceLookup[rid];
      const ext = resFilename.split('.').pop()?.toLowerCase() || '';
      
      let newFilename: string;
      if (imageExts.has(ext)) {
        // 图片：按出现顺序分配 001, 002, 003...
        imageCounter++;
        newFilename = `${noteBaseName}-${String(imageCounter).padStart(3, '0')}.${ext}`;
      } else {
        // 非图片：保留原文件名
        newFilename = resFilename;
      }
      
      ridToNewFilename.set(rid, newFilename);
    }
    
    // 2. 复制文件（如果目标不存在则复制，已存在则跳过）
    // 只有真正需要复制文件时才创建 assets 目录
    let assetsDirCreated = false;
    for (const [rid, newFilename] of ridToNewFilename) {
      const srcPath = path.join(resourceDir, resourceLookup[rid]);
      const dstPath = path.join(assetsDir, newFilename);
      if (fs.existsSync(srcPath) && !fs.existsSync(dstPath)) {
        // 延迟创建目录：只有真正需要复制时才创建
        if (!assetsDirCreated && !fs.existsSync(assetsDir)) {
          fs.mkdirSync(assetsDir, { recursive: true });
          assetsDirCreated = true;
        }
        fs.copyFileSync(srcPath, dstPath);
      }
    }
    
    // 3. 替换链接
    const processed = body.replace(/!\[\]\(:\/([a-f0-9]{32})\)/g, (match, rid) => {
      const newFilename = ridToNewFilename.get(rid);
      if (newFilename) {
        return `![](${newFilename})`;
      }
      return match;
    });

    // 去除 HTML 空格
    return processed.replace(/&nbsp;/g, ' ');
  }

  /** 导入笔记 */
  async importNotes() {
    const { targetFolderName, outputFolder } = this.settings;
    // 展开 ~ 为用户主目录
    const joplinDbPath = this.expandPath(this.settings.joplinDbPath);
    const joplinResourceDir = this.expandPath(this.settings.joplinResourceDir);

    // 验证路径是否存在
    if (!fs.existsSync(joplinDbPath)) {
      new Notice(`❌ Joplin 数据库文件不存在: ${joplinDbPath}`);
      return;
    }

    new Notice('🔄 开始导入 Joplin 笔记...');

    try {
      // 获取插件目录路径（使用 manifest.dir 获取正确的插件目录）
      const vaultBasePath = (this.app.vault.adapter as any).basePath;
      const manifestDir = this.manifest.dir;
      const pluginDir = path.join(vaultBasePath, manifestDir);
      const wasmPath = path.join(pluginDir, 'sql-wasm.wasm');
      
      console.log('Debug paths:', { vaultBasePath, manifestDir, pluginDir, wasmPath });
      
      // 初始化 sql.js，加载本地 wasm 文件
      let SQL;
      if (fs.existsSync(wasmPath)) {
        const wasmBinary = fs.readFileSync(wasmPath);
        SQL = await initSqlJs({ wasmBinary });
      } else {
        new Notice('❌ 找不到 sql-wasm.wasm 文件，请确保插件正确安装');
        console.error('sql-wasm.wasm not found at:', wasmPath);
        console.error('manifest.dir:', manifestDir);
        return;
      }
      
      // 读取数据库文件
      const dbBuffer = fs.readFileSync(joplinDbPath);
      const db = new SQL.Database(dbBuffer);

      // 获取输出目录的绝对路径
      const vaultPath = (this.app.vault.adapter as any).basePath;
      const outputBasePath = outputFolder 
        ? path.join(vaultPath, outputFolder)
        : vaultPath;

      // 确保输出目录存在
      if (!fs.existsSync(outputBasePath)) {
        fs.mkdirSync(outputBasePath, { recursive: true });
      }

      // 获取文件夹层级结构
      const { hierarchy, rootFolderId } = this.getFolderHierarchy(db, targetFolderName);
      console.log(`📁 找到 ${Object.keys(hierarchy).length} 个文件夹`);

      // 构建资源映射
      const resourceLookup = this.buildResourceLookup();
      console.log(`📦 找到 ${Object.keys(resourceLookup).length} 个资源文件`);

      // 不再预先创建所有目录，改为在写入笔记时按需创建（避免创建空文件夹）

      // 获取所有相关文件夹下的笔记
      const folderIds = Object.keys(hierarchy);
      const placeholders = folderIds.map(() => '?').join(',');
      const notesQuery = `SELECT id, title, body, parent_id FROM notes WHERE parent_id IN (${folderIds.map(id => `'${id}'`).join(',')}) AND is_conflict = 0 AND deleted_time = 0`;
      
      const notesResult = db.exec(notesQuery);
      
      if (!notesResult.length || !notesResult[0].values.length) {
        new Notice(`❌ '${targetFolderName}' 文件夹及其子文件夹中没有找到笔记`);
        db.close();
        return;
      }

      const notes = notesResult[0].values;
      console.log(`📝 找到 ${notes.length} 条笔记`);

      let successCount = 0;
      let failCount = 0;

      // 导出笔记
      for (const note of notes) {
        const [noteId, title, body, parentId] = note as [string, string, string, string];
        
        try {
          // 获取笔记所在的文件夹路径
          const folderPath = hierarchy[parentId] || '';

          // 清理文件名
          const safeTitle = this.sanitizeFilename((title || 'Untitled').trim()).slice(0, 100);

          // 确定输出文件路径
          const outputFile = folderPath
            ? path.join(outputBasePath, folderPath, `${safeTitle}.md`)
            : path.join(outputBasePath, `${safeTitle}.md`);

          // 处理笔记内容中的资源链接（图片按 notename-001.ext 格式命名，放在 vault 根目录的 assets）
          let processedBody = body || '';
          if (processedBody) {
            processedBody = this.processResources(processedBody, resourceLookup, vaultPath, safeTitle);
          }

          // 确保笔记所在目录存在（按需创建，避免创建空文件夹）
          const noteDir = path.dirname(outputFile);
          if (!fs.existsSync(noteDir)) {
            fs.mkdirSync(noteDir, { recursive: true });
          }

          // 写入文件
          fs.writeFileSync(outputFile, processedBody, 'utf-8');
          successCount++;
          
          const relativePath = folderPath ? path.join(folderPath, `${safeTitle}.md`) : `${safeTitle}.md`;
          console.log(`✅ 导出: ${relativePath}`);
        } catch (error) {
          failCount++;
          console.error(`❌ 导出失败: ${title}`, error);
        }
      }

      db.close();

      // 刷新 Obsidian 文件列表
      // 触发 vault 重新扫描
      await this.refreshVault(outputFolder);

      new Notice(`🎉 导入完成！成功 ${successCount} 个，失败 ${failCount} 个`);
      console.log(`🎉 导入完成！输出目录: ${outputBasePath}`);

    } catch (error) {
      console.error('导入失败:', error);
      new Notice(`❌ 导入失败: ${error.message}`);
    }
  }

  /** 刷新 vault 文件列表 */
  private async refreshVault(folderPath: string) {
    // 给 Obsidian 一点时间来检测文件变化
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 尝试获取文件夹来触发刷新
    if (folderPath) {
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (folder && folder instanceof TFolder) {
        // 读取文件夹内容来触发刷新
        await this.app.vault.adapter.list(folderPath);
      }
    }
  }
}

class JoplinToObsidianSettingTab extends PluginSettingTab {
  plugin: JoplinToObsidianPlugin;

  constructor(app: App, plugin: JoplinToObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Joplin to Obsidian 设置' });

    containerEl.createEl('p', { 
      text: '配置 Joplin 数据路径和导入选项。导入前请先关闭 Joplin 应用。',
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName('Joplin 数据库路径')
      .setDesc('Joplin SQLite 数据库文件路径，支持 ~ 表示用户主目录')
      .addText(text => text
        .setPlaceholder('~/.config/joplin-desktop/database.sqlite')
        .setValue(this.plugin.settings.joplinDbPath)
        .onChange(async (value) => {
          this.plugin.settings.joplinDbPath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Joplin 资源目录')
      .setDesc('Joplin 资源文件（图片、附件等）的目录路径，支持 ~ 表示用户主目录')
      .addText(text => text
        .setPlaceholder('~/.config/joplin-desktop/resources')
        .setValue(this.plugin.settings.joplinResourceDir)
        .onChange(async (value) => {
          this.plugin.settings.joplinResourceDir = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('要导入的笔记本名称')
      .setDesc('Joplin 中顶级笔记本的名称（将导入该笔记本及其所有子笔记本）')
      .addText(text => text
        .setPlaceholder('joplin')
        .setValue(this.plugin.settings.targetFolderName)
        .onChange(async (value) => {
          this.plugin.settings.targetFolderName = value || 'joplin';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('输出文件夹')
      .setDesc('Obsidian vault 中用于存放导入笔记的文件夹')
      .addText(text => text
        .setPlaceholder('joplin')
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value || 'joplin';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('图片文件夹名称')
      .setDesc('存放图片的文件夹名称（放在 vault 根目录下，图片链接使用简写路径）')
      .addText(text => text
        .setPlaceholder('assets')
        .setValue(this.plugin.settings.attachmentsFolderName)
        .onChange(async (value) => {
          this.plugin.settings.attachmentsFolderName = value || 'assets';
          await this.plugin.saveSettings();
        }));

    // 添加导入按钮
    containerEl.createEl('h3', { text: '导入操作' });

    new Setting(containerEl)
      .setName('开始导入')
      .setDesc('点击按钮开始从 Joplin 导入笔记（也可以使用命令面板）')
      .addButton(button => button
        .setButtonText('导入笔记')
        .setCta()
        .onClick(() => {
          this.plugin.importNotes();
        }));

    // 使用说明
    containerEl.createEl('h3', { text: '使用说明' });
    
    const instructionsList = containerEl.createEl('ol');
    instructionsList.createEl('li', { text: '关闭 Joplin 应用（避免数据库锁定）' });
    instructionsList.createEl('li', { text: '填写上面的配置项' });
    instructionsList.createEl('li', { text: '点击「导入笔记」按钮，或使用命令面板搜索「从 Joplin 导入笔记」' });
    instructionsList.createEl('li', { text: '等待导入完成' });

    containerEl.createEl('p', { 
      text: '提示: Joplin 数据通常在 ~/.config/joplin-desktop/ 目录下',
      cls: 'setting-item-description'
    });
  }
}
