# Rambo 本机唤醒模型

此目录包含 Rambo 使用的离线关键词检测模型，不在运行时下载，也不会把待机音频发送到外部服务。

- 模型：`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`
- 来源：https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models
- 推断库：`sherpa-onnx-node` 2.0.1
- 上游项目：https://github.com/k2-fsa/sherpa-onnx
- 许可：Apache License 2.0，全文见 `LICENSE-APACHE-2.0.txt`

`keywords.txt` 由 Rambo 根据固定唤醒词配置。当前使用中英混合音素覆盖“Rambo”“兰博”“软博”“然博”及对应问候语，不向用户暴露可编辑唤醒词。
