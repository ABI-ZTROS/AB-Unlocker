#!/bin/bash

MODULE_DIR="AB-Unlocker"
OUTPUT_FILE="AB-Unlocker-v1.0.0.zip"

cd "$(dirname "$0")"

echo "正在打包模块..."

# 检查目录是否存在
if [ ! -d "$MODULE_DIR" ]; then
    echo "错误：模块目录 $MODULE_DIR 不存在"
    exit 1
fi

# 删除旧的输出文件
if [ -f "$OUTPUT_FILE" ]; then
    rm "$OUTPUT_FILE"
    echo "已删除旧的打包文件"
fi

# 给所有脚本添加执行权限
chmod +x "$MODULE_DIR"/*.sh 2>/dev/null
chmod +x "$MODULE_DIR"/META-INF/com/google/android/update-binary 2>/dev/null

# 进入模块目录并打包
cd "$MODULE_DIR"
zip -r "../$OUTPUT_FILE" . -x ".*" -x "__MACOSX"

cd ..

if [ -f "$OUTPUT_FILE" ]; then
    echo "✅ 打包成功：$OUTPUT_FILE"
    echo "文件大小：$(du -h $OUTPUT_FILE | cut -f1)"
    echo ""
    echo "模块文件结构："
    unzip -l "$OUTPUT_FILE"
else
    echo "❌ 打包失败"
    exit 1
fi
