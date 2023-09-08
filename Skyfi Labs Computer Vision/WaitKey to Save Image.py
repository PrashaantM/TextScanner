import cv2 as cv
import numpy as np

img = cv.imread('hazard10.jpg')
img1 = cv.imread('hazard10.jpg',0)
## The flag 0 will load the image in grayscale mode

cv.imshow('image',img)
cv.imshow('image1',img1)
key = cv.waitKey(0)

if key == 27:
    cv.destroyAllWindows()
elif key == ord('s'):
    cv.imwrite('grayhazard1.jpg',img1)
    cv.destroyAllWindows()
