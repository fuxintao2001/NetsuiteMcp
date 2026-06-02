import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(path.dirname(__dirname));

/**
 * Installs NetSuite Claude skills either globally or locally.
 * @param {object} options
 * @param {boolean} options.local - If true, installs locally to the current working directory's .claude/skills/
 */
export async function installSkills(options = {}) {
  const localMode = options.local || false;
  
  // Resolve source skills folder
  const sourceSkillsDir = path.join(projectRoot, '.claude', 'skills');
  
  // Resolve destination folder
  let destBaseDir;
  if (localMode) {
    destBaseDir = path.join(process.cwd(), '.claude', 'skills');
    console.error(`📂 [本地安装模式] 目标目录: ${destBaseDir}`);
  } else {
    destBaseDir = path.join(os.homedir(), '.claude', 'skills');
    console.error(`🌍 [全局安装模式] 目标目录: ${destBaseDir}`);
  }

  try {
    // Check if source skills directory exists
    try {
      await fs.access(sourceSkillsDir);
    } catch {
      throw new Error(`找不到内置技能源目录: ${sourceSkillsDir}`);
    }

    // Ensure destination directory exists
    await fs.mkdir(destBaseDir, { recursive: true });

    // Read list of skills inside sourceSkillsDir
    const skills = await fs.readdir(sourceSkillsDir);
    
    let installedCount = 0;
    for (const skillName of skills) {
      const sourceSkillPath = path.join(sourceSkillsDir, skillName);
      const stat = await fs.stat(sourceSkillPath);
      
      if (stat.isDirectory()) {
        const destSkillPath = path.join(destBaseDir, skillName);
        
        // Ensure destination skill directory exists
        await fs.mkdir(destSkillPath, { recursive: true });
        
        // Copy SKILL.md
        const sourceSkillFile = path.join(sourceSkillPath, 'SKILL.md');
        const destSkillFile = path.join(destSkillPath, 'SKILL.md');
        
        try {
          await fs.access(sourceSkillFile);
          await fs.copyFile(sourceSkillFile, destSkillFile);
          console.error(`  ✅ 已安装技能: ${skillName} -> ${destSkillFile}`);
          installedCount++;
        } catch (err) {
          console.error(`  ⚠️  技能 ${skillName} 复制失败: ${err.message}`);
        }
      }
    }

    console.error(`\n🎉 成功安装了 ${installedCount} 个 NetSuite 技能！`);
    if (localMode) {
      console.error(`💡 提示：技能已保存在当前项目根目录的 .claude/ 文件夹中。如果您正在此项目下启动 Claude Code，Claude 将会自动识别这些技能。`);
    } else {
      console.error(`💡 提示：技能已保存在您的全局 Claude 配置目录中。您可以在任何项目中使用 Claude Code 随时通过 /netsuite-record-expert 或 /netsuite-suiteql-expert 唤起这些专业 SOP 引导！`);
    }
    return true;
  } catch (error) {
    console.error(`❌ 技能安装失败: ${error.message}`);
    throw error;
  }
}
