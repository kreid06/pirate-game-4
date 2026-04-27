file = r'c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c'
with open(file, 'r', encoding='utf-8') as f:
    lines = f.readlines()

result = []
i = 0
while i < len(lines):
    if i == 1079:
        result.append('\n')
        i = 2083
    elif i == 4585:
        result.append('\n')
        i = 4904
    else:
        result.append(lines[i])
        i += 1

with open(file, 'w', encoding='utf-8') as f:
    f.writelines(result)
print(f'Done. Was {len(lines)} lines, now {len(result)} lines.')
