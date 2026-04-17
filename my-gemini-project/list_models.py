import replicate

models = replicate.models.list()
for model in models:
    if "deepseek" in model.name.lower() or "coder" in model.name.lower():
        print(model.url)
