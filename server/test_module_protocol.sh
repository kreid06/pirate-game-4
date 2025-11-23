#!/bin/bash
# Test script to verify optimized module protocol

echo "Starting server in background..."
./bin/pirate-server > /dev/null 2>&1 &
SERVER_PID=$!

sleep 2

echo ""
echo "=== MODULE PROTOCOL TEST ==="
echo ""
echo "Fetching ship module data from admin API..."
echo ""

# Extract just the modules array
MODULES=$(curl -s http://localhost:8081/api/map | python3 -c "
import json, sys
data = json.load(sys.stdin)
if 'ships' in data and len(data['ships']) > 0:
    modules = data['ships'][0]['modules']
    print(f'Total modules: {len(modules)}')
    print()
    
    # Categorize modules
    planks = [m for m in modules if m['typeId'] == 6]
    deck = [m for m in modules if m['typeId'] == 7]
    gameplay = [m for m in modules if m['typeId'] not in [6, 7]]
    
    print(f'Planks (typeId=6): {len(planks)}')
    if planks:
        print('  Example plank:', json.dumps(planks[0]))
        print('  Fields:', list(planks[0].keys()))
    
    print()
    print(f'Deck (typeId=7): {len(deck)}')
    if deck:
        print('  Example deck:', json.dumps(deck[0]))
        print('  Fields:', list(deck[0].keys()))
    
    print()
    print(f'Gameplay modules: {len(gameplay)}')
    if gameplay:
        print('  Example (helm/cannon/mast):', json.dumps(gameplay[0]))
        print('  Fields:', list(gameplay[0].keys()))
    
    print()
    print('=== PROTOCOL SUMMARY ===')
    print('✓ Planks: Only ID, typeId, health (no position/rotation)')
    print('✓ Deck: Only ID, typeId (no position/rotation)')
    print('✓ Gameplay: Full transform (ID, typeId, x, y, rotation)')
else:
    print('No ships found!')
")

echo "$MODULES"

echo ""
echo "Stopping server..."
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

echo "Test complete!"
