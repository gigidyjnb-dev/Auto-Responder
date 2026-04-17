import replicate
import os

output = replicate.run(
    "deepseek-ai/deepseek-coder:6.7b-instruct-q4_K_M",
    input={
        "prompt": "Write a Python function that sorts a list of numbers.",
        "temperature": 0.7,
        "top_p": 0.95,
        "top_k": 50,
        "max_tokens": 512
    }
)

print("".join(output))
