"""PyInstaller 打包入口。

app/main.py 使用包内相对导入，不能直接作为冻结入口；
从 backend 目录以顶层脚本方式启动 app 包。
"""
from app.main import main

if __name__ == "__main__":
    main()
