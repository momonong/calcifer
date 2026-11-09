def count_open(tasks):
    return sum(1 for task in tasks if task["status"] == "open")
