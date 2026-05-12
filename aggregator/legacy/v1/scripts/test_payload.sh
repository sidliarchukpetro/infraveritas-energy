#!/bin/bash
echo '{"deviceId":42,"sessionId":1,"epochStartTs":1777700000,"minTotalEnergy":100,"signature":"mock_v1","readings":['
for i in $(seq 1 49); do
  echo '  {"voltage_mv":5500,"current_ma":250,"timestamp_ms":1777700000000},'
done
echo '  {"voltage_mv":5500,"current_ma":250,"timestamp_ms":1777700049000}'
echo ']}'
