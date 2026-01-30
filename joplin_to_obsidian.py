#!/usr/bin/env python3
"""
Joplin to Obsidian 导出脚本
- 图片放在 vault 根目录的 assets 文件夹
- 图片按笔记名重命名：笔记名-001.ext、笔记名-002.ext
- 图片链接使用最简路径：![](笔记名-001.ext)
- 只有需要时才创建目录，避免空文件夹
"""

import os
import sqlite3
import re
import shutil
from pathlib import Path

# === 配置 ===
DB_PATH = os.path.expanduser("~/.config/joplin-desktop/database.sqlite")
JOPLIN_RESOURCE_DIR = os.path.expanduser("~/.config/joplin-desktop/resources")
# Vault 根目录
VAULT_DIR = "/Users/lizhifeng/Library/Mobile Documents/iCloud~md~obsidian/Documents/漂泊者及其影子"
# 笔记输出文件夹（相对于 vault）
OUTPUT_FOLDER = "joplin"
# 图片文件夹（相对于 vault 根目录）
ASSETS_FOLDER = "assets"
# 要导出的 Joplin 笔记本名称
TARGET_FOLDER_NAME = "joplin"

# 图片扩展名
IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'}


def sanitize_filename(name):
    """清理文件名中的非法字符"""
    return re.sub(r'[\\/:"*?<>|]+', "_", name)


def build_resource_lookup():
    """构建资源ID -> 文件名映射"""
    lookup = {}
    if not os.path.exists(JOPLIN_RESOURCE_DIR):
        print(f"⚠️ 资源目录不存在: {JOPLIN_RESOURCE_DIR}")
        return lookup
    
    for fname in os.listdir(JOPLIN_RESOURCE_DIR):
        if re.match(r"^[a-f0-9]{32}\.\w+$", fname):
            rid = fname.split(".")[0]
            lookup[rid] = fname
    return lookup


def get_folder_hierarchy(cursor, target_folder_name):
    """获取文件夹层级结构"""
    cursor.execute(
        "SELECT id FROM folders WHERE title = ? AND parent_id = ''",
        (target_folder_name,)
    )
    root_folder = cursor.fetchone()
    if not root_folder:
        raise ValueError(f"❌ 找不到名为 '{target_folder_name}' 的 Joplin 笔记本")
    
    root_folder_id = root_folder[0]
    folder_hierarchy = {root_folder_id: ""}
    
    def build_hierarchy(parent_id, path=""):
        cursor.execute(
            "SELECT id, title FROM folders WHERE parent_id = ?",
            (parent_id,)
        )
        subfolders = cursor.fetchall()
        
        for folder_id, folder_title in subfolders:
            folder_path = os.path.join(path, sanitize_filename(folder_title)) if path else sanitize_filename(folder_title)
            folder_hierarchy[folder_id] = folder_path
            build_hierarchy(folder_id, folder_path)
    
    build_hierarchy(root_folder_id)
    return folder_hierarchy, root_folder_id


def process_resources(body, resource_lookup, note_base_name, assets_dir):
    """
    处理笔记内容中的资源链接
    - 图片按笔记名重命名：笔记名-001.ext
    - 所有资源放在 vault 根目录的 assets 文件夹
    - 链接使用最简路径
    """
    # 先扫描所有资源引用，按出现顺序分配序号
    resource_matches = re.findall(r'!\[\]\(:/([a-f0-9]{32})\)', body)
    rid_to_new_filename = {}
    image_counter = 0
    
    # 去重但保持顺序
    seen_rids = set()
    unique_rids = []
    for rid in resource_matches:
        if rid not in seen_rids:
            seen_rids.add(rid)
            unique_rids.append(rid)
    
    for rid in unique_rids:
        if rid not in resource_lookup:
            print(f"⚠️ 未找到资源: {rid}")
            continue
        
        res_filename = resource_lookup[rid]
        ext = res_filename.split(".")[-1].lower()
        
        if ext in IMAGE_EXTENSIONS:
            # 图片：按笔记名+序号命名
            image_counter += 1
            new_filename = f"{note_base_name}-{image_counter:03d}.{ext}"
        else:
            # 非图片：保留原文件名
            new_filename = res_filename
        
        rid_to_new_filename[rid] = new_filename
    
    # 复制文件（如果目标不存在）
    assets_created = False
    for rid, new_filename in rid_to_new_filename.items():
        src_path = os.path.join(JOPLIN_RESOURCE_DIR, resource_lookup[rid])
        dst_path = os.path.join(assets_dir, new_filename)
        
        if os.path.exists(src_path) and not os.path.exists(dst_path):
            # 延迟创建目录
            if not assets_created and not os.path.exists(assets_dir):
                os.makedirs(assets_dir, exist_ok=True)
                assets_created = True
            shutil.copyfile(src_path, dst_path)
    
    # 替换链接
    def replace_resource(match):
        rid = match.group(1)
        if rid in rid_to_new_filename:
            new_filename = rid_to_new_filename[rid]
            # 使用最简路径
            return f"![]({new_filename})"
        return match.group(0)
    
    body_processed = re.sub(r'!\[\]\(:/([a-f0-9]{32})\)', replace_resource, body)
    # 去除 HTML 空格
    body_processed = body_processed.replace("&nbsp;", " ")
    return body_processed


def export_notes():
    """导出笔记"""
    # 验证数据库路径
    if not os.path.exists(DB_PATH):
        print(f"❌ Joplin 数据库不存在: {DB_PATH}")
        return
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    try:
        # 获取文件夹层级结构
        folder_hierarchy, root_folder_id = get_folder_hierarchy(cursor, TARGET_FOLDER_NAME)
        print(f"📁 找到 {len(folder_hierarchy)} 个文件夹")
        
        # 构建资源映射
        resource_lookup = build_resource_lookup()
        print(f"📦 找到 {len(resource_lookup)} 个资源文件")
        
        # 获取所有相关文件夹下的笔记
        folder_ids = list(folder_hierarchy.keys())
        placeholders = ','.join('?' * len(folder_ids))
        cursor.execute(
            f"SELECT id, title, body, parent_id FROM notes "
            f"WHERE parent_id IN ({placeholders}) AND is_conflict = 0 AND deleted_time = 0",
            folder_ids
        )
        notes = cursor.fetchall()
        
        if not notes:
            print(f"❌ '{TARGET_FOLDER_NAME}' 文件夹及其子文件夹中没有找到笔记")
            return
        
        print(f"📝 找到 {len(notes)} 条笔记")
        
        # 计算路径
        output_dir = os.path.join(VAULT_DIR, OUTPUT_FOLDER) if OUTPUT_FOLDER else VAULT_DIR
        assets_dir = os.path.join(VAULT_DIR, ASSETS_FOLDER)
        
        # 导出笔记
        success_count = 0
        fail_count = 0
        
        for note_id, title, body, parent_id in notes:
            try:
                # 获取笔记所在的文件夹路径
                folder_path = folder_hierarchy.get(parent_id, "")
                
                # 清理文件名
                title = (title or "Untitled").strip()
                safe_title = sanitize_filename(title)[:100]
                
                # 确定输出文件路径
                if folder_path:
                    note_dir = os.path.join(output_dir, folder_path)
                    output_file = os.path.join(note_dir, f"{safe_title}.md")
                    relative_path = os.path.join(folder_path, f"{safe_title}.md")
                else:
                    note_dir = output_dir
                    output_file = os.path.join(output_dir, f"{safe_title}.md")
                    relative_path = f"{safe_title}.md"
                
                # 处理笔记内容中的资源链接
                processed_body = body or ""
                if processed_body:
                    processed_body = process_resources(
                        processed_body,
                        resource_lookup,
                        safe_title,
                        assets_dir
                    )
                
                # 确保笔记目录存在（按需创建）
                if not os.path.exists(note_dir):
                    os.makedirs(note_dir, exist_ok=True)
                
                # 写入文件
                with open(output_file, "w", encoding="utf-8") as f:
                    f.write(processed_body)
                
                success_count += 1
                print(f"✅ 导出: {relative_path}")
                
            except Exception as e:
                fail_count += 1
                print(f"❌ 导出失败: {title} - {e}")
        
        print(f"\n🎉 导出完成！成功 {success_count} 个，失败 {fail_count} 个")
        print(f"📁 笔记目录: {output_dir}")
        print(f"🖼️ 图片目录: {assets_dir}")
        
    except ValueError as e:
        print(str(e))
    finally:
        conn.close()


if __name__ == "__main__":
    export_notes()
