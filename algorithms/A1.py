#!/usr/bin/python
import sys
import json
from pprint import pprint

with open('/home/thp/WISPFrontEnd/algorithms/data_test.json') as data_file:
    data = json.load(data_file)

print json.dumps(data)
