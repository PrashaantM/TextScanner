import cv2 as cv
import numpy as np

img = cv.imread('hazard10.jpg')
img1 = cv.imread('hazard10.jpg',0)

cv.imshow('image',img)
cv.imshow('image1',img1)
cv.imwrite('grayhazard.jpg',img1)

cv.waitKey(0)
cv.destroyAllWindows()
